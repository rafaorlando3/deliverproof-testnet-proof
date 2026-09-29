// Revisão do Claude (M2a), independente dos testes do Codex:
// verifyAgreement contra um nó Hardhat de verdade, lido por JSON-RPC (viem), com os
// fluxos completos e com um leitor que mente, falha ou devolve histórico parcial.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import path from 'node:path';
import {
  BaseError,
  ContractFunctionRevertedError,
  createPublicClient,
  createWalletClient,
  custom,
  encodeErrorResult,
  http,
  keccak256,
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
} from 'viem';
import { hardhat } from 'viem/chains';
import { CID } from 'multiformats/cid';
import { sha256 } from 'multiformats/hashes/sha2';
import { deliverProofAbi } from '../src/abi.js';
import {
  verifyAgreement,
  type ChainLog,
  type ChainReader,
  type NetworkResult,
  type TrustedDeployment,
} from '../src/network.js';
import { artifact, hardhatDir, startNode } from './hardhat-node.js';
import { viemReader } from './viem-reader.js';

const DP = artifact();
let stop: () => Promise<void>, url: string;
let pub: PublicClient, wallet: WalletClient;
let deployer: Address, buyer: Address, supplier: Address, stranger: Address;

beforeAll(async () => {
  ({ url, stop } = await startNode());
  pub = createPublicClient({ chain: hardhat, transport: http(url), pollingInterval: 20 }) as PublicClient;
  wallet = createWalletClient({ chain: hardhat, transport: http(url) });
  [deployer, buyer, supplier, stranger] = (await wallet.getAddresses()) as Address[];
}, 90_000);
afterAll(async () => {
  await stop?.();
});

async function mined(hash: Hex) {
  const r = await pub.waitForTransactionReceipt({ hash });
  expect(r.status).toBe('success');
  return r;
}
async function deploy(): Promise<TrustedDeployment> {
  const hash = await wallet.deployContract({ account: deployer, chain: hardhat, abi: DP.abi, bytecode: DP.bytecode });
  const r = await mined(hash);
  return {
    chainId: 31337,
    address: r.contractAddress!,
    deployer,
    deploymentTx: hash,
    deploymentBlock: r.blockNumber,
    runtimeCodeHash: keccak256(DP.deployedBytecode),
  };
}
function call(t: TrustedDeployment, from: Address, functionName: string, args: unknown[], value?: bigint) {
  return wallet
    .writeContract({
      account: from,
      chain: hardhat,
      address: t.address,
      abi: deliverProofAbi,
      functionName: functionName as never,
      args: args as never,
      value,
    } as never)
    .then(mined);
}
async function now() {
  return (await pub.getBlock()).timestamp;
}
async function create(t: TrustedDeployment, amount = 5_000n, terms = keccak256('0x01')) {
  const ts = await now();
  const r = await call(t, buyer, 'createAgreement', [supplier, amount, ts + 3600n, ts + 7200n, terms]);
  const nextId = (await pub.readContract({ address: t.address, abi: DP.abi, functionName: 'nextId' })) as bigint;
  return { id: nextId - 1n, hash: r.transactionHash, amount };
}
async function file(text: string) {
  const bytes = new TextEncoder().encode(text);
  const d = await sha256.digest(bytes);
  return {
    cid: CID.createV1(0x55, d).toString(),
    sha: ('0x' + Buffer.from(d.digest).toString('hex')) as Hex,
    size: BigInt(bytes.length),
  };
}
async function submit(t: TrustedDeployment, id: bigint, text = 'entrega final') {
  const f = await file(text);
  return call(t, supplier, 'submit', [id, f.cid, f.sha, f.size, 1]);
}
async function commitmentOf(t: TrustedDeployment, id: bigint) {
  return (
    await pub.readContract({ address: t.address, abi: deliverProofAbi, functionName: 'getAgreement', args: [id] })
  ).commitment;
}
async function timeJump(seconds: number) {
  await pub.request({ method: 'evm_increaseTime', params: [seconds] } as never);
  await pub.request({ method: 'evm_mine', params: [] } as never);
}
const reader = () => viemReader(pub);
function events(r: NetworkResult) {
  expect(r).toMatchObject({ status: 'verified', code: 'chain_matches' });
  return r.status === 'verified' ? r.milestones.map(m => m.event) : [];
}
/** Leitor que repassa tudo ao nó real, trocando só o que o caso precisa. */
function lying(over: Partial<ChainReader>): ChainReader {
  return { ...reader(), ...over };
}

describe('âncora e código implantado', () => {
  it('o hash do runtime do artifact compilado é o hash do código no nó', async () => {
    const t = await deploy();
    expect(keccak256((await pub.getCode({ address: t.address }))!)).toBe(t.runtimeCodeHash);
  });
});

describe('fluxo de aprovação completo, verificado a cada passo', () => {
  it('Created → Funded → Submitted → Approved → CreditAvailable → Withdrawn', async () => {
    const t = await deploy();
    const a = await create(t);
    const sent: Hex[] = [a.hash];
    expect(events(await verifyAgreement(t, a.id, reader()))).toEqual(['Created']);

    sent.push((await call(t, buyer, 'fund', [a.id], a.amount)).transactionHash);
    expect(events(await verifyAgreement(t, a.id, reader()))).toEqual(['Created', 'Funded']);

    sent.push((await submit(t, a.id)).transactionHash);
    const afterSubmit = await verifyAgreement(t, a.id, reader());
    expect(events(afterSubmit)).toEqual(['Created', 'Funded', 'Submitted']);
    const f = await file('entrega final');
    if (afterSubmit.status === 'verified')
      expect(afterSubmit.delivery).toMatchObject({ cid: f.cid, fileSha256: f.sha, fileSize: f.size, mediaType: 1 });

    const approve = await call(t, buyer, 'approve', [a.id, await commitmentOf(t, a.id)]);
    sent.push(approve.transactionHash, approve.transactionHash);
    expect(events(await verifyAgreement(t, a.id, reader()))).toEqual([
      'Created',
      'Funded',
      'Submitted',
      'Approved',
      'CreditAvailable',
    ]);

    sent.push((await call(t, supplier, 'withdraw', [a.id])).transactionHash);
    const end = await verifyAgreement(t, a.id, reader());
    expect(events(end)).toEqual(['Created', 'Funded', 'Submitted', 'Approved', 'CreditAvailable', 'Withdrawn']);
    if (end.status === 'verified') {
      expect(end.agreement).toMatchObject({ state: 4, withdrawn: true });
      expect(end.milestones.map(m => m.hash)).toEqual(sent);
    }
  });
});

describe('fluxos de devolução', () => {
  it('fornecedor devolve antes de entregar; comprador saca', async () => {
    const t = await deploy();
    const a = await create(t);
    await call(t, buyer, 'fund', [a.id], a.amount);
    await call(t, supplier, 'refund', [a.id]);
    expect(events(await verifyAgreement(t, a.id, reader()))).toEqual([
      'Created',
      'Funded',
      'Refunded',
      'CreditAvailable',
    ]);
    await call(t, buyer, 'withdraw', [a.id]);
    const r = await verifyAgreement(t, a.id, reader());
    expect(events(r)).toEqual(['Created', 'Funded', 'Refunded', 'CreditAvailable', 'Withdrawn']);
    if (r.status === 'verified') expect(r.delivery).toBeNull();
  });
  it('comprador devolve depois do reviewDeadline, com entrega feita; comprador saca', async () => {
    const t = await deploy();
    const a = await create(t);
    await call(t, buyer, 'fund', [a.id], a.amount);
    await submit(t, a.id);
    await timeJump(7201);
    await call(t, buyer, 'refund', [a.id]);
    expect(events(await verifyAgreement(t, a.id, reader()))).toEqual([
      'Created',
      'Funded',
      'Submitted',
      'Refunded',
      'CreditAvailable',
    ]);
    await call(t, buyer, 'withdraw', [a.id]);
    const r = await verifyAgreement(t, a.id, reader());
    expect(events(r)).toEqual(['Created', 'Funded', 'Submitted', 'Refunded', 'CreditAvailable', 'Withdrawn']);
    if (r.status === 'verified') expect(r.agreement).toMatchObject({ state: 5, withdrawn: true });
  });
});

describe('outro contrato e outro acordo', () => {
  it('segunda implantação com o mesmo bytecode: cada âncora só aceita o próprio contrato', async () => {
    const A = await deploy(),
      B = await deploy();
    expect(B.runtimeCodeHash).toBe(A.runtimeCodeHash); // mesmo código: só endereço + tx de deploy distinguem
    const a = await create(A, 5_000n, keccak256('0xaa'));
    const b = await create(B, 7_000n, keccak256('0xbb'));
    expect(b.id).toBe(a.id);
    expect(events(await verifyAgreement(A, a.id, reader()))).toEqual(['Created']);
    expect(events(await verifyAgreement(B, b.id, reader()))).toEqual(['Created']);
    expect(
      await verifyAgreement({ ...B, deploymentTx: A.deploymentTx, deploymentBlock: A.deploymentBlock }, a.id, reader()),
    ).toEqual({ status: 'mismatch', code: 'deployment_mismatch' });
    // RPC que ignora o filtro de endereço e mistura o evento real do contrato B
    const bLogs = await reader().logs(B.address, b.id, B.deploymentBlock, await pub.getBlockNumber());
    const mixed = lying({ logs: async (...p) => [...(await reader().logs(...p)), ...bLogs] });
    expect(await verifyAgreement(A, a.id, mixed)).toEqual({ status: 'mismatch', code: 'wrong_event_contract' });
  });
  it('eventos de outro acordo no mesmo contrato não entram', async () => {
    const t = await deploy();
    const a1 = await create(t);
    const a2 = await create(t);
    await call(t, buyer, 'fund', [a2.id], a2.amount);
    const other = await reader().logs(t.address, a2.id, t.deploymentBlock, await pub.getBlockNumber());
    expect(events(await verifyAgreement(t, a1.id, reader()))).toEqual(['Created']);
    const mixed = lying({ logs: async (...p) => [...(await reader().logs(...p)), ...other] });
    expect(await verifyAgreement(t, a1.id, mixed)).toEqual({ status: 'mismatch', code: 'wrong_event_agreement' });
  });
  it('financiamento forjado por um contrato que imita os eventos nunca vira verified', async () => {
    const t = await deploy();
    const a = await create(t);
    const { mimic } = await helpers();
    const ag = await pub.readContract({
      address: t.address,
      abi: deliverProofAbi,
      functionName: 'getAgreement',
      args: [a.id],
    });
    const fakeTx = await wallet.writeContract({
      account: stranger,
      chain: hardhat,
      address: mimic,
      abi: MIMIC_ABI,
      functionName: 'fake',
      args: [a.id, buyer, supplier, ag.amountTinybar, ag.deliveryDeadline, ag.reviewDeadline, ag.termsHash],
    });
    const fr = await mined(fakeTx);
    const fakeFunded = fr.logs[1]!;
    const asLog = (addr: Address): ChainLog => ({
      address: addr,
      topics: fakeFunded.topics as Hex[],
      data: fakeFunded.data,
      transactionHash: fakeTx,
      blockNumber: fr.blockNumber,
      blockHash: fr.blockHash,
      logIndex: fakeFunded.logIndex,
      removed: false,
    });
    const claimsFunded = {
      agreement: async (...p: Parameters<ChainReader['agreement']>) => ({
        ...(await reader().agreement(...p)),
        state: 2,
      }),
    };
    // 1) RPC devolve o log do imitador como está
    expect(
      await verifyAgreement(
        t,
        a.id,
        lying({ ...claimsFunded, logs: async (...p) => [...(await reader().logs(...p)), asLog(mimic)] }),
      ),
    ).toEqual({ status: 'mismatch', code: 'wrong_event_contract' });
    // 2) RPC reescreve o endereço do log para o contrato verdadeiro
    expect(
      await verifyAgreement(
        t,
        a.id,
        lying({ ...claimsFunded, logs: async (...p) => [...(await reader().logs(...p)), asLog(t.address)] }),
      ),
    ).toEqual({ status: 'inconclusive', code: 'receipt_log_missing' });
  });
});

describe('histórico ausente, duplicado ou fora de ordem', () => {
  async function approvedAndWithdrawn() {
    const t = await deploy();
    const a = await create(t);
    await call(t, buyer, 'fund', [a.id], a.amount);
    await submit(t, a.id);
    await call(t, buyer, 'approve', [a.id, await commitmentOf(t, a.id)]);
    await call(t, supplier, 'withdraw', [a.id]);
    const all = await reader().logs(t.address, a.id, t.deploymentBlock, await pub.getBlockNumber());
    return { t, a, all };
  }
  const nameOf = (l: ChainLog) =>
    (
      deliverProofAbi.find(
        x =>
          x.type === 'event' &&
          l.topics[0] === keccak256(new TextEncoder().encode(`${x.name}(${x.inputs.map(i => i.type).join(',')})`)),
      ) as { name: string }
    ).name;

  it('ordem trocada pela RPC ainda verifica (a ordem vem de bloco e logIndex)', async () => {
    const { t, a, all } = await approvedAndWithdrawn();
    expect(events(await verifyAgreement(t, a.id, lying({ logs: async () => [...all].reverse() })))).toHaveLength(6);
  });
  it.each(['Created', 'Funded', 'Submitted', 'Approved', 'CreditAvailable', 'Withdrawn'])(
    'sem %s: inconclusive, nunca verified',
    async ev => {
      const { t, a, all } = await approvedAndWithdrawn();
      const r = await verifyAgreement(t, a.id, lying({ logs: async () => all.filter(l => nameOf(l) !== ev) }));
      expect(r.status).toBe('inconclusive');
      expect(r.code).toBe('incomplete_event_history');
    },
  );
  it.each(['Created', 'Approved', 'Withdrawn'])('%s duplicado: inconclusive', async ev => {
    const { t, a, all } = await approvedAndWithdrawn();
    const dup = all.find(l => nameOf(l) === ev)!;
    expect(await verifyAgreement(t, a.id, lying({ logs: async () => [...all, { ...dup }] }))).toEqual({
      status: 'inconclusive',
      code: 'duplicate_rpc_log',
    });
  });
  it('log com transactionHash de outra transação real do acordo: não verifica', async () => {
    const { t, a, all } = await approvedAndWithdrawn();
    const swapped = all.map(l => (nameOf(l) === 'Approved' ? { ...l, transactionHash: all[0]!.transactionHash } : l));
    const r = await verifyAgreement(t, a.id, lying({ logs: async () => swapped }));
    expect(r.status).not.toBe('verified');
  });
});

describe('estado do acordo e histórico de nós diferentes', () => {
  it('getAgreement de um nó atrasado (estado real de um bloco anterior) com logs novos: inconclusive', async () => {
    const t = await deploy();
    const a = await create(t);
    await call(t, buyer, 'fund', [a.id], a.amount);
    const s = await submit(t, a.id);
    await call(t, buyer, 'approve', [a.id, await commitmentOf(t, a.id)]);
    await call(t, supplier, 'withdraw', [a.id]);
    const stale = lying({ agreement: async (addr, id) => reader().agreement(addr, id, s.blockNumber) });
    expect((await reader().agreement(t.address, a.id, s.blockNumber)).state).toBe(3);
    expect(await verifyAgreement(t, a.id, stale)).toEqual({ status: 'inconclusive', code: 'incomplete_event_history' });
  });
  it('valor do depósito na escala do Hedera (x10^10) numa rede 31337: mismatch', async () => {
    const t = await deploy();
    const a = await create(t);
    await call(t, buyer, 'fund', [a.id], a.amount);
    const scaled = lying({
      transaction: async h => {
        const x = await reader().transaction(h);
        return { ...x, value: x.value * 10_000_000_000n };
      },
    });
    expect(await verifyAgreement(t, a.id, scaled)).toEqual({ status: 'mismatch', code: 'deposit_value_mismatch' });
  });
});

describe('RPC parcial ou instável', () => {
  async function funded() {
    const t = await deploy();
    const a = await create(t);
    const f = await call(t, buyer, 'fund', [a.id], a.amount);
    return { t, a, fundTx: f.transactionHash, fundBlock: f.blockNumber };
  }
  it('recibo do depósito some: inconclusive/not_found', async () => {
    const { t, a, fundTx } = await funded();
    const r = await verifyAgreement(
      t,
      a.id,
      lying({ receipt: async h => (h === fundTx ? null : reader().receipt(h)) }),
    );
    expect(r).toEqual({ status: 'inconclusive', code: 'not_found' });
  });
  it('getLogs, transação, código ou getAgreement caem: inconclusive/rpc_unavailable', async () => {
    const { t, a } = await funded();
    const boom = async () => {
      throw new Error('ECONNRESET');
    };
    for (const over of [{ logs: boom }, { transaction: boom }, { code: boom }, { agreement: boom }]) {
      expect(await verifyAgreement(t, a.id, lying(over))).toEqual({ status: 'inconclusive', code: 'rpc_unavailable' });
    }
  });
  it('bloco de um evento antigo com outro hash (reorg): inconclusive/history_changed', async () => {
    const { t, a, fundBlock } = await funded();
    const createdBlock = (await pub.getTransactionReceipt({ hash: a.hash })).blockNumber;
    expect(createdBlock).toBeLessThan(fundBlock); // não é o bloco do snapshot, que tem checagem própria no fim
    const r = await verifyAgreement(
      t,
      a.id,
      lying({
        block: async n => {
          const b = await reader().block(n);
          return n === createdBlock ? { ...b, hash: keccak256(b.hash) } : b;
        },
      }),
    );
    expect(r).toEqual({ status: 'inconclusive', code: 'history_changed' });
  });
  it('bloco do snapshot muda durante a leitura: inconclusive/history_changed', async () => {
    const { t, a } = await funded();
    await create(t); // bloco do snapshot sem evento deste acordo: só a releitura final o confere
    let latestSeen: bigint | undefined;
    const r = await verifyAgreement(
      t,
      a.id,
      lying({
        block: async n => {
          const b = await reader().block(n);
          if (n === 'latest') {
            latestSeen = b.number;
            return b;
          }
          return n === latestSeen ? { ...b, hash: keccak256(b.hash) } : b;
        },
      }),
    );
    expect(r).toEqual({ status: 'inconclusive', code: 'history_changed' });
  });
  it('getLogs traz o depósito, mas o recibo da transação não tem esse log: inconclusive/receipt_log_missing', async () => {
    const { t, a, fundTx } = await funded();
    const r = await verifyAgreement(
      t,
      a.id,
      lying({
        receipt: async h => {
          const x = await reader().receipt(h);
          return x && h === fundTx ? { ...x, logs: [] } : x;
        },
      }),
    );
    expect(r).toEqual({ status: 'inconclusive', code: 'receipt_log_missing' });
  });
  it('nó atrasado em relação ao deploy: inconclusive/node_behind', async () => {
    const { t, a } = await funded();
    const r = await verifyAgreement(
      t,
      a.id,
      lying({
        block: async n => {
          const b = await reader().block(n);
          return n === 'latest' ? { ...b, number: t.deploymentBlock - 1n } : b;
        },
      }),
    );
    expect(r).toEqual({ status: 'inconclusive', code: 'node_behind' });
  });
  it('sem código no endereço: inconclusive/code_unavailable', async () => {
    const { t, a } = await funded();
    expect(await verifyAgreement(t, a.id, lying({ code: async () => undefined }))).toEqual({
      status: 'inconclusive',
      code: 'code_unavailable',
    });
  });
  it('acordo com campo faltando: inconclusive/malformed_response', async () => {
    const { t, a } = await funded();
    const r = await verifyAgreement(
      t,
      a.id,
      lying({
        agreement: async (...p) => {
          const x = { ...(await reader().agreement(...p)) } as Record<string, unknown>;
          delete x.termsHash;
          return x as never;
        },
      }),
    );
    expect(r).toEqual({ status: 'inconclusive', code: 'malformed_response' });
  });
});

describe('limite do eth_getLogs no relay do Hedera (7 dias por consulta)', () => {
  // Simula a recusa do relay por largura de faixa. Aqui o limite é em blocos (5) para caber no teste;
  // no relay o limite é tempo: TIMESTAMP_RANGE_TOO_LARGE acima de 604800 s, mesmo com um endereço só.
  function limited(maxSpan: bigint): PublicClient {
    const base = createPublicClient({ chain: hardhat, transport: http(url) });
    return createPublicClient({
      chain: hardhat,
      transport: custom({
        async request({ method, params }: { method: string; params?: unknown }) {
          if (method === 'eth_getLogs') {
            const [{ fromBlock, toBlock }] = params as [{ fromBlock: Hex; toBlock: Hex }];
            if (BigInt(toBlock) - BigInt(fromBlock) > maxSpan)
              throw Object.assign(new Error('TIMESTAMP_RANGE_TOO_LARGE'), { code: -32004 });
          }
          return base.request({ method, params } as never);
        },
      }),
    }) as PublicClient;
  }
  it('uma consulta do deploy até o último bloco falha quando a faixa passa do limite; com janelas, verifica', async () => {
    const t = await deploy();
    const a = await create(t);
    for (let i = 0; i < 8; i++) await create(t); // blocos extras entre o deploy e o depósito
    await call(t, buyer, 'fund', [a.id], a.amount);
    expect(await verifyAgreement(t, a.id, viemReader(limited(5n)))).toEqual({
      status: 'inconclusive',
      code: 'rpc_unavailable',
    });
    expect(events(await verifyAgreement(t, a.id, viemReader(limited(5n), { maxBlocksPerLogQuery: 5n })))).toEqual([
      'Created',
      'Funded',
    ]);
    expect(events(await verifyAgreement(t, a.id, viemReader(pub, { maxBlocksPerLogQuery: 1n })))).toEqual([
      'Created',
      'Funded',
    ]);
  });
});

describe('M2c: janelas com timestamp real no EVM', () => {
  it('a mesma prova com salto de oito dias falha sem janelas e passa no paginador de produção', async () => {
    const t = await deploy();
    const a = await create(t);
    await call(t, buyer, 'fund', [a.id], a.amount);
    await pub.request({ method: 'evm_increaseTime', params: [8 * 86_400] } as never);
    await pub.request({ method: 'evm_mine', params: [] } as never);
    const spans: bigint[] = [];
    const limited = createPublicClient({
      chain: hardhat,
      transport: custom({
        async request({ method, params }: { method: string; params?: unknown }) {
          if (method === 'eth_getLogs') {
            const [filter] = params as [{ fromBlock: Hex; toBlock: Hex }];
            const first = await pub.getBlock({ blockNumber: BigInt(filter.fromBlock) });
            const last = await pub.getBlock({ blockNumber: BigInt(filter.toBlock) });
            const span = last.timestamp - first.timestamp;
            spans.push(span);
            if (span > 7n * 86_400n) throw Object.assign(new Error('TIMESTAMP_RANGE_TOO_LARGE'), { code: -32004 });
          }
          return pub.request({ method, params } as never);
        },
      }),
    }) as PublicClient;
    expect(await verifyAgreement(t, a.id, viemReader(limited))).toEqual({
      status: 'inconclusive',
      code: 'rpc_unavailable',
    });
    spans.length = 0;
    expect(events(await verifyAgreement(t, a.id, viemReader(limited, { timeWindows: true })))).toEqual([
      'Created',
      'Funded',
    ]);
    expect(spans.length).toBeGreaterThan(1);
    expect(spans.every(s => s <= 6n * 86_400n)).toBe(true);
  });
});

describe('lista do VALIDATION-M2.md: RPC que mente de forma coerente (logs e recibos iguais)', () => {
  async function done() {
    const t = await deploy();
    const a = await create(t);
    await call(t, buyer, 'fund', [a.id], a.amount);
    await submit(t, a.id);
    await call(t, buyer, 'approve', [a.id, await commitmentOf(t, a.id)]);
    await call(t, supplier, 'withdraw', [a.id]);
    return { t, a };
  }
  const topicOf = (name: string) => {
    const e = deliverProofAbi.find(x => x.type === 'event' && x.name === name) as unknown as {
      inputs: readonly { type: string }[];
    };
    return keccak256(new TextEncoder().encode(`${name}(${e.inputs.map(i => i.type).join(',')})`));
  };
  /** Troca o mesmo log em getLogs e no recibo, para a mentira passar pelas conferências de consistência. */
  function rewrite(name: string, fn: (l: ChainLog) => ChainLog): ChainReader {
    const fix = (l: ChainLog) => (l.topics[0] === topicOf(name) ? fn({ ...l }) : l);
    return lying({
      logs: async (...p) => (await reader().logs(...p)).map(fix),
      receipt: async h => {
        const r = await reader().receipt(h);
        return r && { ...r, logs: r.logs.map(fix) };
      },
    });
  }
  const addrTopic = (a: Address) => ('0x' + a.slice(2).toLowerCase().padStart(64, '0')) as Hex;
  const amountData = (n: bigint) => ('0x' + n.toString(16).padStart(64, '0')) as Hex;
  it('crédito para o beneficiário errado: mismatch/credit_mismatch', async () => {
    const { t, a } = await done();
    expect(
      await verifyAgreement(
        t,
        a.id,
        rewrite('CreditAvailable', l => ({ ...l, topics: [l.topics[0]!, l.topics[1]!, addrTopic(buyer)] })),
      ),
    ).toEqual({ status: 'mismatch', code: 'credit_mismatch' });
  });
  it('crédito com valor diferente: mismatch/credit_mismatch', async () => {
    const { t, a } = await done();
    expect(
      await verifyAgreement(
        t,
        a.id,
        rewrite('CreditAvailable', l => ({ ...l, data: amountData(a.amount + 1n) })),
      ),
    ).toEqual({ status: 'mismatch', code: 'credit_mismatch' });
  });
  it('saque para outra conta ou com outro valor: mismatch/withdrawal_mismatch', async () => {
    const { t, a } = await done();
    expect(
      await verifyAgreement(
        t,
        a.id,
        rewrite('Withdrawn', l => ({ ...l, topics: [l.topics[0]!, l.topics[1]!, addrTopic(stranger)] })),
      ),
    ).toEqual({ status: 'mismatch', code: 'withdrawal_mismatch' });
    expect(
      await verifyAgreement(
        t,
        a.id,
        rewrite('Withdrawn', l => ({ ...l, data: amountData(a.amount - 1n) })),
      ),
    ).toEqual({ status: 'mismatch', code: 'withdrawal_mismatch' });
  });
  it('aprovação com outro compromisso: mismatch/approval_mismatch', async () => {
    const { t, a } = await done();
    expect(
      await verifyAgreement(
        t,
        a.id,
        rewrite('Approved', l => ({ ...l, topics: [l.topics[0]!, l.topics[1]!, keccak256('0x09')] })),
      ),
    ).toEqual({ status: 'mismatch', code: 'approval_mismatch' });
  });
  it('âncora com outro deployer: mismatch/deployment_mismatch', async () => {
    const { t, a } = await done();
    expect(await verifyAgreement({ ...t, deployer: stranger }, a.id, reader())).toEqual({
      status: 'mismatch',
      code: 'deployment_mismatch',
    });
  });
  it('histórico acima de 256 eventos: inconclusive/event_limit', async () => {
    const { t, a } = await done();
    const all = await reader().logs(t.address, a.id, t.deploymentBlock, await pub.getBlockNumber());
    const big = Array.from({ length: 257 }, (_, i) => ({ ...all[i % all.length]!, logIndex: 1000 + i }));
    expect(await verifyAgreement(t, a.id, lying({ logs: async () => big }))).toEqual({
      status: 'inconclusive',
      code: 'event_limit',
    });
  });
  it('o mesmo arquivo em dois acordos: compromissos diferentes, cada um verifica só o seu; o compromisso do outro não aprova', async () => {
    const t = await deploy();
    const a1 = await create(t);
    const a2 = await create(t);
    for (const a of [a1, a2]) {
      await call(t, buyer, 'fund', [a.id], a.amount);
      await submit(t, a.id, 'mesmo arquivo');
    }
    const c1 = await commitmentOf(t, a1.id),
      c2 = await commitmentOf(t, a2.id);
    expect(c1).not.toBe(c2);
    const r1 = await verifyAgreement(t, a1.id, reader()),
      r2 = await verifyAgreement(t, a2.id, reader());
    if (r1.status !== 'verified' || r2.status !== 'verified') throw new Error('esperava verified nos dois');
    expect(r1.delivery?.cid).toBe(r2.delivery?.cid);
    await expect(
      pub.simulateContract({
        account: buyer,
        address: t.address,
        abi: DP.abi,
        functionName: 'approve',
        args: [a1.id, c2],
      }),
    ).rejects.toThrow(/WrongCommitment/);
  });
});

describe('classificações decididas no M2c', () => {
  it('carteira-contrato com evento real é inconclusive/unsupported_caller', async () => {
    const t = await deploy();
    const { wallet: w } = await helpers();
    const ts = await now();
    await mined(
      await wallet.writeContract({
        account: buyer,
        chain: hardhat,
        address: w,
        abi: WALLET_ABI,
        functionName: 'create',
        args: [t.address, supplier, 5_000n, ts + 3600n, ts + 7200n, keccak256('0x02')],
      }),
    );
    const id = ((await pub.readContract({ address: t.address, abi: DP.abi, functionName: 'nextId' })) as bigint) - 1n;
    const ag = await pub.readContract({
      address: t.address,
      abi: deliverProofAbi,
      functionName: 'getAgreement',
      args: [id],
    });
    expect(ag.buyer.toLowerCase()).toBe(w.toLowerCase()); // o comprador on-chain é a carteira-contrato
    expect(await verifyAgreement(t, id, reader())).toEqual({ status: 'inconclusive', code: 'unsupported_caller' });
  });
  it('id inexistente é distinguido de falha de RPC pelo revert decodificado', async () => {
    const t = await deploy();
    expect(await verifyAgreement(t, 999n, reader())).toEqual({ status: 'inconclusive', code: 'unknown_agreement' });
  });
  it('ABI declara os erros e viem nomeia WrongCommitment', async () => {
    const t = await deploy();
    const a = await create(t);
    await call(t, buyer, 'fund', [a.id], a.amount);
    await submit(t, a.id);
    let data: Hex | undefined;
    try {
      await pub.simulateContract({
        account: buyer,
        address: t.address,
        abi: deliverProofAbi,
        functionName: 'approve',
        args: [a.id, keccak256('0x03')],
      });
    } catch (e) {
      const rev = (e as BaseError).walk(
        x => x instanceof ContractFunctionRevertedError,
      ) as ContractFunctionRevertedError | null;
      expect(rev?.data?.errorName).toBe('WrongCommitment');
      data = rev?.raw;
    }
    expect(data).toMatch(/^0x[0-9a-f]{8}$/);
    expect(data).toBe(encodeErrorResult({ abi: deliverProofAbi, errorName: 'WrongCommitment' }));
  });
});

// ---------- contratos auxiliares, compilados em memória com o mesmo solc 0.8.28 fixado ----------
const HELPERS_SOL = `// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;
interface IDP { function createAgreement(address,uint64,uint64,uint64,bytes32) external returns (uint256); }
contract ForwardingWallet {
  address private immutable owner;
  constructor() { owner = msg.sender; }
  function create(IDP dp, address s, uint64 a, uint64 d, uint64 r, bytes32 t) external { require(msg.sender == owner); dp.createAgreement(s, a, d, r, t); }
}
contract EventMimic {
  event Created(uint256 indexed id, address indexed buyer, address indexed supplier, uint64 amountTinybar, uint64 deliveryDeadline, uint64 reviewDeadline, bytes32 termsHash);
  event Funded(uint256 indexed id, uint64 amountTinybar);
  function fake(uint256 id, address b, address s, uint64 a, uint64 d, uint64 r, bytes32 t) external { emit Created(id, b, s, a, d, r, t); emit Funded(id, a); }
}`;
const WALLET_ABI = [
  {
    type: 'function',
    name: 'create',
    stateMutability: 'nonpayable',
    outputs: [],
    inputs: [
      { name: 'dp', type: 'address' },
      { name: 's', type: 'address' },
      { name: 'a', type: 'uint64' },
      { name: 'd', type: 'uint64' },
      { name: 'r', type: 'uint64' },
      { name: 't', type: 'bytes32' },
    ],
  },
] as const;
const MIMIC_ABI = [
  {
    type: 'function',
    name: 'fake',
    stateMutability: 'nonpayable',
    outputs: [],
    inputs: [
      { name: 'id', type: 'uint256' },
      { name: 'b', type: 'address' },
      { name: 's', type: 'address' },
      { name: 'a', type: 'uint64' },
      { name: 'd', type: 'uint64' },
      { name: 'r', type: 'uint64' },
      { name: 't', type: 'bytes32' },
    ],
  },
] as const;
let helperCache: Promise<{ wallet: Address; mimic: Address }> | undefined;
function helpers() {
  return (helperCache ??= (async () => {
    const solc = createRequire(path.join(hardhatDir, 'package.json'))('solc');
    const out = JSON.parse(
      solc.compile(
        JSON.stringify({
          language: 'Solidity',
          sources: { 'H.sol': { content: HELPERS_SOL } },
          settings: {
            optimizer: { enabled: true, runs: 200 },
            evmVersion: 'paris',
            outputSelection: { '*': { '*': ['evm.bytecode.object'] } },
          },
        }),
      ),
    );
    const errs = (out.errors ?? []).filter((e: { severity: string }) => e.severity === 'error');
    if (errs.length) throw new Error(JSON.stringify(errs));
    const dep = async (name: string, from: Address) =>
      (
        await mined(
          await wallet.deployContract({
            account: from,
            chain: hardhat,
            abi: [],
            bytecode: ('0x' + out.contracts['H.sol'][name].evm.bytecode.object) as Hex,
          }),
        )
      ).contractAddress!;
    return { wallet: await dep('ForwardingWallet', buyer), mimic: await dep('EventMimic', stranger) };
  })());
}
