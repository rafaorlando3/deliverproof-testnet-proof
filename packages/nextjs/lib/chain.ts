import { createPublicClient, defineChain, http, decodeEventLog, toHex, keccak256, type Address, type Hex } from 'viem';
import { deliverProofAbi } from '@deliverproof/core/abi';
import {
  validateDeployment,
  type TrustedDeployment,
  type ChainReader,
  type ChainLog,
  type ChainReceipt,
  type Agreement,
} from '@deliverproof/core/network';
import { inspectTransaction } from '@deliverproof/core/receipt';
import { logsInTimeWindows } from '@deliverproof/core/log-windows';
import { throwAgreementReadError } from '@deliverproof/core/read-errors';
import configured from './deployment.json';

type Manifest = Omit<TrustedDeployment, 'deploymentBlock'> & { deploymentBlock: string };
export function deployment(): TrustedDeployment | null {
  if (!configured) return null;
  try {
    const value = configured as unknown as Manifest;
    const t = { ...value, deploymentBlock: BigInt(value.deploymentBlock) };
    validateDeployment(t);
    return t;
  } catch {
    return null;
  }
}
export function clients(t: TrustedDeployment) {
  const chain = defineChain({
    id: t.chainId,
    name: t.chainId === 296 ? 'Hedera testnet' : 'Local EVM',
    nativeCurrency: {
      name: t.chainId === 296 ? 'Test HBAR' : 'Local accounting units',
      symbol: t.chainId === 296 ? 'HBAR' : 'UNIT',
      decimals: 18,
    },
    rpcUrls: { default: { http: [t.chainId === 296 ? 'https://testnet.hashio.io/api' : 'http://127.0.0.1:8545'] } },
  });
  const client = createPublicClient({ chain, transport: http(undefined, { timeout: 15000, retryCount: 0 }) });
  const reader: ChainReader = {
    chainId: () => client.getChainId(),
    block: async n => {
      const b = await client.getBlock(n === 'latest' ? { blockTag: 'latest' } : { blockNumber: n });
      if (b.number === null || b.hash === null) throw new Error('block unavailable');
      return { number: b.number, hash: b.hash, timestamp: b.timestamp };
    },
    code: (address, blockNumber) => client.getBytecode({ address, blockNumber }),
    receipt: async hash => {
      try {
        return (await client.getTransactionReceipt({ hash })) as unknown as ChainReceipt;
      } catch (e) {
        if (e instanceof Error && e.name === 'TransactionReceiptNotFoundError') return null;
        throw e;
      }
    },
    transaction: async hash => {
      const tx = await client.getTransaction({ hash });
      return { hash: tx.hash, from: tx.from, to: tx.to, value: tx.value };
    },
    agreement: async (address, id, blockNumber) => {
      try {
        return (await client.readContract({
          address,
          abi: deliverProofAbi,
          functionName: 'getAgreement',
          args: [id],
          blockNumber,
        })) as Agreement;
      } catch (e) {
        throwAgreementReadError(e);
      }
    },
    logs: async (address, id, from, to) => {
      // Indexed agreement id is topic 1 for every DeliverProof event; never accept a receipt-provided filter.
      return logsInTimeWindows(from, to, {
        block: n => reader.block(n),
        logs: async (start, end) => {
          const rows = await client.request({
            method: 'eth_getLogs',
            params: [
              { address, fromBlock: toHex(start), toBlock: toHex(end), topics: [null, toHex(id, { size: 32 })] },
            ],
          });
          return rows.map(l => {
            if (l.blockNumber === null || l.blockHash === null || l.transactionHash === null || l.logIndex === null)
              throw new Error('incomplete log');
            return { ...l, blockNumber: BigInt(l.blockNumber), logIndex: Number(BigInt(l.logIndex)) } as ChainLog;
          });
        },
      });
    },
  };
  return { chain, client, reader };
}
export function createdId(
  logs: readonly { address: Address; topics: readonly Hex[]; data: Hex }[],
  address: Address,
): bigint | null {
  for (const l of logs)
    if (l.address.toLowerCase() === address.toLowerCase()) {
      try {
        const e = decodeEventLog({ abi: deliverProofAbi, data: l.data, topics: l.topics as [Hex, ...Hex[]] });
        if (e.eventName === 'Created') return e.args.id;
      } catch {
        /* Other event. */
      }
    }
  return null;
}
/** Creation has no agreement id yet, but still requires the same independent deployment anchor. */
export async function assertDeployment(t: TrustedDeployment, reader: ChainReader) {
  validateDeployment(t);
  if ((await reader.chainId()) !== t.chainId) throw new Error('The read RPC is on a different network.');
  const r = await reader.receipt(t.deploymentTx);
  const verdict = await inspectTransaction(t.deploymentTx, async () => r);
  if (verdict.status !== 'confirmed' || !r) throw new Error('Deployment receipt is unavailable or unsuccessful.');
  const b = await reader.block(r.blockNumber),
    tip = await reader.block('latest');
  const code = await reader.code(t.address, tip.number);
  const eq = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
  if (
    r.to !== null ||
    !r.contractAddress ||
    !eq(r.contractAddress, t.address) ||
    !eq(r.from, t.deployer) ||
    r.blockNumber !== t.deploymentBlock ||
    b.number !== r.blockNumber ||
    !eq(b.hash, r.blockHash) ||
    !code ||
    code === '0x' ||
    !eq(keccak256(code), t.runtimeCodeHash)
  )
    throw new Error('Deployment provenance does not match this installation.');
}
