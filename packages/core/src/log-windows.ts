import type { ChainLog } from './network.js';
import { ChainReadError } from './read-errors.js';

type BlockTime = { number: bigint; timestamp: bigint };
type HistorySource = {
  block(n: bigint): Promise<BlockTime>;
  logs(from: bigint, to: bigint): Promise<ChainLog[]>;
};
type Limits = {
  maxSpanSeconds?: bigint;
  maxQueries?: number;
  maxBlockReads?: number;
  maxLogs?: number;
  maxDurationMs?: number;
};

/** Partition inclusive block ranges using observed timestamps, never estimated block cadence.
 * A failed window/budget discards the whole read. No partial history can become a proof.
 * Six days leaves headroom below the Hedera relay's seven-day timestamp range limit.
 * The source must bound each request (the browser transport uses 15s, no retries).
 */
export async function logsInTimeWindows(
  from: bigint,
  to: bigint,
  source: HistorySource,
  limits: Limits = {},
): Promise<ChainLog[]> {
  const span = limits.maxSpanSeconds ?? 6n * 86_400n;
  const maxQueries = limits.maxQueries ?? 64,
    maxBlocks = limits.maxBlockReads ?? 256;
  const maxLogs = limits.maxLogs ?? 256,
    duration = limits.maxDurationMs ?? 60_000;
  if (
    typeof from !== 'bigint' ||
    typeof to !== 'bigint' ||
    from < 0n ||
    to < from ||
    to >= 2n ** 256n ||
    typeof span !== 'bigint' ||
    span < 1n ||
    ![maxQueries, maxBlocks, maxLogs, duration].every(n => Number.isSafeInteger(n) && n > 0)
  ) {
    throw new ChainReadError('malformed_history');
  }
  const deadline = Date.now() + duration;
  const cache = new Map<bigint, BlockTime>();
  const ranges: [bigint, bigint][] = [[from, to]];
  const result: ChainLog[] = [];
  let queries = 0;
  function budget() {
    if (Date.now() >= deadline) throw new ChainReadError('history_query_budget');
  }
  async function block(n: bigint): Promise<BlockTime> {
    budget();
    if (cache.has(n)) return cache.get(n)!;
    if (cache.size >= maxBlocks) throw new ChainReadError('history_query_budget');
    const b = await source.block(n);
    budget();
    if (!b || b.number !== n || typeof b.timestamp !== 'bigint' || b.timestamp < 0n)
      throw new ChainReadError('malformed_history');
    cache.set(n, b);
    return b;
  }
  while (ranges.length) {
    const [start, end] = ranges.pop()!;
    const a = await block(start),
      b = await block(end);
    if (a.timestamp > b.timestamp) throw new ChainReadError('malformed_history');
    if (b.timestamp - a.timestamp > span) {
      const middle = (start + end) / 2n;
      const left = await block(middle),
        right = await block(middle + 1n);
      if (left.timestamp < a.timestamp || right.timestamp < left.timestamp || right.timestamp > b.timestamp) {
        throw new ChainReadError('malformed_history');
      }
      // Push right first so windows are queried chronologically. No gaps or shared boundary blocks.
      ranges.push([middle + 1n, end], [start, middle]);
      continue;
    }
    budget();
    if (++queries > maxQueries) throw new ChainReadError('history_query_budget');
    const rows = await source.logs(start, end);
    budget();
    if (!Array.isArray(rows)) throw new ChainReadError('malformed_history');
    if (result.length + rows.length > maxLogs) throw new ChainReadError('event_limit');
    if (rows.some(l => !l || typeof l.blockNumber !== 'bigint' || l.blockNumber < start || l.blockNumber > end)) {
      throw new ChainReadError('malformed_history');
    }
    result.push(...rows);
  }
  return result;
}
