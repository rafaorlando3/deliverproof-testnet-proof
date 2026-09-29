import { decodeEventLog, keccak256, type Address, type Hex } from 'viem';
import { deliverProofAbi } from './abi.js';
import { deliveryCommitment, rpcValueForTinybars, type Delivery } from './delivery.js';
import { inspectTransaction } from './receipt.js';
import { ChainReadError } from './read-errors.js';

/** Supplied by this installation's operator after checking compiled bytecode and deployment.
 * Never populate it from a receipt, query string, wallet, or a user-uploaded JSON file. */
export type TrustedDeployment = {
  chainId: 296 | 31337;
  address: Address;
  deployer: Address;
  deploymentTx: Hex;
  deploymentBlock: bigint;
  runtimeCodeHash: Hex;
};
export type Agreement = {
  buyer: Address;
  supplier: Address;
  amountTinybar: bigint;
  deliveryDeadline: bigint;
  reviewDeadline: bigint;
  termsHash: Hex;
  state: number;
  commitment: Hex;
  cid: string;
  fileSha256: Hex;
  fileSize: bigint;
  mediaType: number;
  withdrawn: boolean;
};
export type ChainBlock = { number: bigint; hash: Hex; timestamp: bigint };
export type ChainLog = {
  address: Address;
  topics: readonly Hex[];
  data: Hex;
  transactionHash: Hex;
  blockNumber: bigint;
  blockHash: Hex;
  logIndex: number;
  removed: boolean;
};
export type ChainReceipt = {
  transactionHash: Hex;
  blockHash: Hex;
  blockNumber: bigint;
  status: 'success' | 'reverted';
  from: Address;
  to: Address | null;
  contractAddress: Address | null;
  logs: ChainLog[];
};
export interface ChainReader {
  chainId(): Promise<number>;
  block(number: bigint | 'latest'): Promise<ChainBlock>;
  code(address: Address, block: bigint): Promise<Hex | undefined>;
  receipt(hash: Hex): Promise<ChainReceipt | null>;
  transaction(hash: Hex): Promise<{ hash: Hex; from: Address; to: Address | null; value: bigint }>;
  agreement(address: Address, id: bigint, block: bigint): Promise<Agreement>;
  logs(address: Address, id: bigint, from: bigint, to: bigint): Promise<ChainLog[]>;
}
export type NetworkResult =
  | {
      status: 'verified';
      code: 'chain_matches';
      agreement: Agreement;
      snapshot: ChainBlock;
      delivery: Delivery | null;
      milestones: { event: string; hash: Hex; block: bigint }[];
    }
  | { status: 'mismatch' | 'inconclusive'; code: string };
class EvidenceError extends Error {
  constructor(
    readonly status: 'mismatch' | 'inconclusive',
    readonly code: string,
  ) {
    super(code);
  }
}
const hash = (x: unknown): x is Hex => typeof x === 'string' && /^0x[0-9a-f]{64}$/i.test(x) && !/^0x0{64}$/.test(x);
const addr = (x: unknown): x is Address => typeof x === 'string' && /^0x[0-9a-f]{40}$/i.test(x) && !/^0x0{40}$/.test(x);
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
function check(ok: unknown, code: string): asserts ok {
  if (!ok) throw new EvidenceError('mismatch', code);
}
function incomplete(ok: unknown, code = 'malformed_response'): asserts ok {
  if (!ok) throw new EvidenceError('inconclusive', code);
}

export function validateDeployment(t: TrustedDeployment): void {
  if (
    !t ||
    ![296, 31337].includes(t.chainId) ||
    !addr(t.address) ||
    !addr(t.deployer) ||
    !hash(t.deploymentTx) ||
    !hash(t.runtimeCodeHash) ||
    typeof t.deploymentBlock !== 'bigint' ||
    t.deploymentBlock < 0n
  ) {
    throw new Error('invalid_trusted_deployment');
  }
}

function validateAgreement(a: Agreement) {
  incomplete(
    a &&
      addr(a.buyer) &&
      addr(a.supplier) &&
      hash(a.termsHash) &&
      typeof a.amountTinybar === 'bigint' &&
      a.amountTinybar > 0n &&
      a.amountTinybar <= 1_000_000_000n &&
      typeof a.deliveryDeadline === 'bigint' &&
      typeof a.reviewDeadline === 'bigint' &&
      a.reviewDeadline > a.deliveryDeadline &&
      Number.isInteger(a.state) &&
      a.state >= 1 &&
      a.state <= 5 &&
      typeof a.withdrawn === 'boolean',
  );
}
function validBlock(b: ChainBlock) {
  incomplete(b && typeof b.number === 'bigint' && b.number >= 0n && hash(b.hash) && typeof b.timestamp === 'bigint');
}

/** No wallet required. Reads a fixed block, validates code provenance, canonical receipts,
 * event identities/actors/amounts, and compares the event history with stored agreement state.
 * Trust boundary: independently queried RPC, not a cryptographic light client or finality guarantee.
 * Missing or inconsistent history is inconclusive. No exported receipt can set the trust anchor. */
export async function verifyAgreement(t: TrustedDeployment, id: bigint, reader: ChainReader): Promise<NetworkResult> {
  try {
    validateDeployment(t);
    if (typeof id !== 'bigint' || id < 1n || id >= 2n ** 256n) throw new Error();
  } catch {
    return { status: 'inconclusive', code: 'invalid_expected_context' };
  }
  try {
    if ((await reader.chainId()) !== t.chainId) return { status: 'inconclusive', code: 'wrong_rpc_network' };
    const snapshot = await reader.block('latest');
    validBlock(snapshot);
    incomplete(snapshot.number >= t.deploymentBlock, 'node_behind');
    const receipts = new Map<string, ChainReceipt>();
    async function receipt(h: Hex): Promise<ChainReceipt> {
      if (receipts.has(h.toLowerCase())) return receipts.get(h.toLowerCase())!;
      const r = await reader.receipt(h);
      const state = await inspectTransaction(h, async () => r);
      if (state.status !== 'confirmed')
        throw new EvidenceError(state.status === 'failed' ? 'mismatch' : 'inconclusive', state.code);
      incomplete(r && Array.isArray(r.logs) && addr(r.from));
      incomplete(r.blockNumber <= snapshot.number, 'node_behind');
      const b = await reader.block(r.blockNumber);
      validBlock(b);
      incomplete(b.number === r.blockNumber && same(b.hash, r.blockHash), 'history_changed');
      receipts.set(h.toLowerCase(), r);
      return r;
    }
    const deploy = await receipt(t.deploymentTx);
    check(
      deploy.blockNumber === t.deploymentBlock &&
        deploy.to === null &&
        !!deploy.contractAddress &&
        same(deploy.contractAddress, t.address) &&
        same(deploy.from, t.deployer),
      'deployment_mismatch',
    );
    const code = await reader.code(t.address, snapshot.number);
    incomplete(typeof code === 'string' && /^0x[0-9a-f]+$/i.test(code), 'code_unavailable');
    check(same(keccak256(code), t.runtimeCodeHash), 'runtime_code_mismatch');
    const a = await reader.agreement(t.address, id, snapshot.number);
    validateAgreement(a);
    const logs = await reader.logs(t.address, id, t.deploymentBlock, snapshot.number);
    incomplete(Array.isArray(logs) && logs.length <= 256, 'event_limit');
    const events: { name: string; args: Record<string, unknown>; log: ChainLog; from: Address }[] = [];
    const identities = new Set<string>();
    for (const l of logs) {
      incomplete(
        l &&
          addr(l.address) &&
          hash(l.transactionHash) &&
          hash(l.blockHash) &&
          typeof l.blockNumber === 'bigint' &&
          l.blockNumber >= t.deploymentBlock &&
          l.blockNumber <= snapshot.number &&
          Number.isSafeInteger(l.logIndex) &&
          l.logIndex >= 0 &&
          Array.isArray(l.topics) &&
          typeof l.data === 'string',
      );
      check(same(l.address, t.address), 'wrong_event_contract');
      incomplete(l.removed === false, 'history_changed');
      let e: { eventName: string; args: Record<string, unknown> };
      try {
        e = decodeEventLog({
          abi: deliverProofAbi,
          data: l.data,
          topics: l.topics as [Hex, ...Hex[]],
          strict: true,
        }) as typeof e;
      } catch {
        throw new EvidenceError('inconclusive', 'unreadable_event');
      }
      check(e.args.id === id, 'wrong_event_agreement');
      const key = `${l.transactionHash.toLowerCase()}:${l.logIndex}`;
      incomplete(!identities.has(key), 'duplicate_rpc_log');
      identities.add(key);
      const r = await receipt(l.transactionHash);
      incomplete(r.blockNumber === l.blockNumber && same(r.blockHash, l.blockHash), 'history_changed');
      incomplete(
        r.logs.some(
          x =>
            x.logIndex === l.logIndex &&
            same(x.address, l.address) &&
            x.data === l.data &&
            JSON.stringify(x.topics) === JSON.stringify(l.topics),
        ),
        'receipt_log_missing',
      );
      // A real event reached via a forwarding contract is outside the direct-call model.
      // Confirm receipt membership first: a rewritten imitator log must not take this path.
      incomplete(r.to !== null && same(r.to, t.address), 'unsupported_caller');
      events.push({ name: e.eventName, args: e.args, log: l, from: r.from });
    }
    events.sort((x, y) =>
      x.log.blockNumber < y.log.blockNumber
        ? -1
        : x.log.blockNumber > y.log.blockNumber
          ? 1
          : x.log.logIndex - y.log.logIndex,
    );
    const named = (name: string) => events.filter(x => x.name === name);
    const one = (name: string) => {
      const xs = named(name);
      incomplete(xs.length === 1, 'incomplete_event_history');
      return xs[0]!;
    };
    const created = one('Created');
    check(
      same(String(created.args.buyer), a.buyer) &&
        same(String(created.args.supplier), a.supplier) &&
        same(created.from, a.buyer) &&
        created.args.amountTinybar === a.amountTinybar &&
        created.args.deliveryDeadline === a.deliveryDeadline &&
        created.args.reviewDeadline === a.reviewDeadline &&
        same(String(created.args.termsHash), a.termsHash),
      'created_terms_mismatch',
    );
    const submitted = named('Submitted');
    incomplete(submitted.length <= 1, 'incomplete_event_history');
    let delivery: Delivery | null = null;
    if (submitted.length) {
      const e = submitted[0]!;
      delivery = {
        chainId: t.chainId,
        contract: t.address,
        agreementId: id,
        termsHash: a.termsHash,
        cid: a.cid,
        fileSha256: a.fileSha256,
        fileSize: a.fileSize,
        mediaType: a.mediaType as 1 | 2 | 3,
        version: 1,
      };
      let computed: Hex;
      try {
        computed = deliveryCommitment(delivery);
      } catch {
        throw new EvidenceError('mismatch', 'delivery_metadata_mismatch');
      }
      check(
        same(e.from, a.supplier) &&
          same(String(e.args.commitment), computed) &&
          same(a.commitment, computed) &&
          e.args.cid === a.cid &&
          same(String(e.args.fileSha256), a.fileSha256) &&
          e.args.fileSize === a.fileSize &&
          Number(e.args.mediaType) === a.mediaType &&
          Number(e.args.version) === 1,
        'submitted_mismatch',
      );
    }
    const path = ['Created'];
    if (a.state >= 2) {
      const f = one('Funded');
      check(f.args.amountTinybar === a.amountTinybar && same(f.from, a.buyer), 'funded_mismatch');
      const tx = await reader.transaction(f.log.transactionHash);
      incomplete(tx && hash(tx.hash) && addr(tx.from) && typeof tx.value === 'bigint');
      check(
        same(tx.hash, f.log.transactionHash) &&
          tx.to !== null &&
          same(tx.to, t.address) &&
          same(tx.from, a.buyer) &&
          tx.value === rpcValueForTinybars(t.chainId, a.amountTinybar),
        'deposit_value_mismatch',
      );
      path.push('Funded');
    }
    if (delivery) path.push('Submitted');
    if (a.state === 3 || a.state === 4) incomplete(delivery, 'incomplete_event_history');
    if (a.state === 1 || a.state === 2) incomplete(!delivery, 'inconsistent_snapshot');
    if (a.state === 4 || a.state === 5) {
      const beneficiary = a.state === 4 ? a.supplier : a.buyer;
      const event = a.state === 4 ? 'Approved' : 'Refunded';
      const action = one(event),
        credit = one('CreditAvailable');
      if (a.state === 4)
        check(same(action.from, a.buyer) && same(String(action.args.commitment), a.commitment), 'approval_mismatch');
      else
        check(
          (same(action.from, a.buyer) || same(action.from, a.supplier)) &&
            same(String(action.args.initiator), action.from),
          'refund_mismatch',
        );
      check(
        credit.args.amountTinybar === a.amountTinybar &&
          same(String(credit.args.beneficiary), beneficiary) &&
          same(credit.log.transactionHash, action.log.transactionHash),
        'credit_mismatch',
      );
      path.push(event, 'CreditAvailable');
      if (a.withdrawn) {
        const w = one('Withdrawn');
        check(
          w.args.amountTinybar === a.amountTinybar &&
            same(String(w.args.beneficiary), beneficiary) &&
            same(w.from, beneficiary),
          'withdrawal_mismatch',
        );
        path.push('Withdrawn');
      }
    } else incomplete(!a.withdrawn, 'inconsistent_snapshot');
    incomplete(events.map(x => x.name).join(',') === path.join(','), 'incomplete_event_history');
    const end = await reader.block(snapshot.number);
    validBlock(end);
    incomplete(end.number === snapshot.number && same(end.hash, snapshot.hash), 'history_changed');
    return {
      status: 'verified',
      code: 'chain_matches',
      agreement: a,
      snapshot,
      delivery,
      milestones: events.map(x => ({ event: x.name, hash: x.log.transactionHash, block: x.log.blockNumber })),
    };
  } catch (e) {
    if (e instanceof EvidenceError) return { status: e.status, code: e.code };
    if (e instanceof ChainReadError) return { status: 'inconclusive', code: e.code };
    return { status: 'inconclusive', code: 'rpc_unavailable' };
  }
}
