import type { Hex } from 'viem';

export type TransactionEvidence =
  | { status: 'confirmed'; blockNumber: bigint; blockHash: Hex }
  | { status: 'failed'; code: 'reverted' | 'wrong_transaction' }
  | { status: 'inconclusive'; code: 'not_found' | 'rpc_unavailable' | 'malformed_response' };

/** Deliberately narrow: confirmation is not proof of a particular contract event.
 * Domain/event verification must also pass before a UI can label an action complete. */
export async function inspectTransaction(hash: Hex, read: () => Promise<unknown>): Promise<TransactionEvidence> {
  if (!/^0x[0-9a-fA-F]{64}$/.test(hash) || /^0x0{64}$/.test(hash)) {
    return { status: 'inconclusive', code: 'malformed_response' };
  }
  let value: unknown;
  try {
    value = await read();
  } catch {
    return { status: 'inconclusive', code: 'rpc_unavailable' };
  }
  if (value === null) return { status: 'inconclusive', code: 'not_found' };
  if (typeof value !== 'object' || value === null) return { status: 'inconclusive', code: 'malformed_response' };
  const r = value as Record<string, unknown>;
  const isHash = (s: unknown): s is Hex =>
    typeof s === 'string' && /^0x[0-9a-fA-F]{64}$/.test(s) && !/^0x0{64}$/.test(s);
  if (
    !isHash(r.transactionHash) ||
    !isHash(r.blockHash) ||
    typeof r.blockNumber !== 'bigint' ||
    r.blockNumber < 0n ||
    (r.status !== 'success' && r.status !== 'reverted')
  )
    return { status: 'inconclusive', code: 'malformed_response' };
  if (r.transactionHash.toLowerCase() !== hash.toLowerCase()) return { status: 'failed', code: 'wrong_transaction' };
  if (r.status === 'reverted') return { status: 'failed', code: 'reverted' };
  return { status: 'confirmed', blockNumber: r.blockNumber, blockHash: r.blockHash };
}
