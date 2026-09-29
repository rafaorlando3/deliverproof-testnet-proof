// Revisão do Claude (M2a): um ChainReader de verdade, sobre JSON-RPC via viem.
// Não é fonte do Codex; serve de referência para o leitor do frontend.
// `maxBlocksPerLogQuery` divide o eth_getLogs em janelas. No Hedera, o relay recusa
// eth_getLogs com mais de 7 dias entre fromBlock e toBlock (TIMESTAMP_RANGE_TOO_LARGE),
// mesmo com um único endereço, então um leitor sem janelas deixa de funcionar 7 dias
// depois do deploy.
import { TransactionReceiptNotFoundError, numberToHex, pad, type Address, type Hex, type PublicClient } from 'viem';
import { deliverProofAbi } from '../src/abi.js';
import type { Agreement, ChainLog, ChainReader, ChainReceipt } from '../src/network.js';
import { throwAgreementReadError } from '../src/read-errors.js';
import { logsInTimeWindows } from '../src/log-windows.js';

type RawLog = {
  address: Address;
  topics: Hex[];
  data: Hex;
  transactionHash: Hex;
  blockNumber: Hex;
  blockHash: Hex;
  logIndex: Hex;
  removed?: boolean;
};

export function viemReader(
  client: PublicClient,
  opts: { maxBlocksPerLogQuery?: bigint; timeWindows?: boolean } = {},
): ChainReader {
  const toLog = (l: RawLog): ChainLog => ({
    address: l.address,
    topics: l.topics,
    data: l.data,
    transactionHash: l.transactionHash,
    blockNumber: BigInt(l.blockNumber),
    blockHash: l.blockHash,
    logIndex: Number(BigInt(l.logIndex)),
    removed: l.removed === true,
  });
  return {
    chainId: () => client.getChainId(),
    async block(n) {
      const b =
        n === 'latest' ? await client.getBlock({ blockTag: 'latest' }) : await client.getBlock({ blockNumber: n });
      return { number: b.number!, hash: b.hash!, timestamp: b.timestamp };
    },
    code: (address, blockNumber) => client.getCode({ address, blockNumber }),
    async receipt(hash): Promise<ChainReceipt | null> {
      try {
        const r = await client.getTransactionReceipt({ hash });
        return {
          transactionHash: r.transactionHash,
          blockHash: r.blockHash,
          blockNumber: r.blockNumber,
          status: r.status,
          from: r.from,
          to: r.to,
          contractAddress: r.contractAddress ?? null,
          logs: r.logs.map(l => ({
            address: l.address,
            topics: l.topics as Hex[],
            data: l.data,
            transactionHash: l.transactionHash!,
            blockNumber: l.blockNumber!,
            blockHash: l.blockHash!,
            logIndex: l.logIndex!,
            removed: l.removed === true,
          })),
        };
      } catch (e) {
        if (e instanceof TransactionReceiptNotFoundError) return null;
        throw e;
      }
    },
    async transaction(hash) {
      const t = await client.getTransaction({ hash });
      return { hash: t.hash, from: t.from, to: t.to, value: t.value };
    },
    async agreement(address, id, blockNumber) {
      try {
        const a = await client.readContract({
          address,
          abi: deliverProofAbi,
          functionName: 'getAgreement',
          args: [id],
          blockNumber,
        });
        return { ...a, state: Number(a.state), mediaType: Number(a.mediaType) } as Agreement;
      } catch (e) {
        throwAgreementReadError(e);
      }
    },
    async logs(address, id, from, to) {
      const query = async (start: bigint, end: bigint) => {
        const raw = (await client.request({
          method: 'eth_getLogs',
          params: [
            {
              address,
              fromBlock: numberToHex(start),
              toBlock: numberToHex(end),
              topics: [null, pad(numberToHex(id))],
            },
          ],
        } as never)) as RawLog[];
        return raw.map(toLog);
      };
      if (opts.timeWindows)
        return logsInTimeWindows(from, to, {
          block: async n => {
            const b = await client.getBlock({ blockNumber: n });
            return { number: b.number!, timestamp: b.timestamp };
          },
          logs: query,
        });
      const step = opts.maxBlocksPerLogQuery ?? to - from + 1n;
      const out: ChainLog[] = [];
      for (let start = from; start <= to; start += step) {
        const end = start + step - 1n < to ? start + step - 1n : to;
        out.push(...(await query(start, end)));
      }
      return out;
    },
  };
}
