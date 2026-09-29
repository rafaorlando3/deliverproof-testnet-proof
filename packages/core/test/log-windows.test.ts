import { afterEach, describe, expect, it, vi } from 'vitest';
import { logsInTimeWindows } from '../src/log-windows.js';
import { ChainReadError, throwAgreementReadError } from '../src/read-errors.js';
import type { ChainLog } from '../src/network.js';

const day = 86_400n;
// These tests exercise the reader's partitioning, not event authenticity (network tests do that).
const log = (n: bigint) => ({ blockNumber: n }) as ChainLog;
function fixture(times: bigint[], events: bigint[] = []) {
  const windows: [bigint, bigint][] = [];
  const reads: bigint[] = [];
  const source = {
    block: async (n: bigint) => {
      reads.push(n);
      return { number: n, timestamp: times[Number(n)]! };
    },
    logs: async (from: bigint, to: bigint) => {
      windows.push([from, to]);
      if (times[Number(to)]! - times[Number(from)]! > 7n * day) throw new Error('TIMESTAMP_RANGE_TOO_LARGE');
      return events.filter(n => n >= from && n <= to).map(log);
    },
  };
  return { windows, reads, source };
}
afterEach(() => vi.useRealTimers());
describe('timestamp-bounded complete log history', () => {
  it('covers irregular cadence and multi-day gaps once, including every boundary', async () => {
    const times = [0n, 1n, day, 9n * day, 9n * day + 1n, 20n * day];
    const f = fixture(times, [0n, 1n, 2n, 3n, 4n, 5n]);
    expect((await logsInTimeWindows(0n, 5n, f.source)).map(l => l.blockNumber)).toEqual([0n, 1n, 2n, 3n, 4n, 5n]);
    expect(f.windows[0]![0]).toBe(0n);
    expect(f.windows.at(-1)![1]).toBe(5n);
    f.windows.forEach(([a, b], i) => {
      expect(times[Number(b)]! - times[Number(a)]!).toBeLessThanOrEqual(6n * day);
      if (i) expect(a).toBe(f.windows[i - 1]![1] + 1n);
    });
    expect(new Set(f.reads).size).toBe(f.reads.length);
  });
  it('keeps the exact six-day boundary in one query', async () => {
    const f = fixture([0n, 6n * day], [0n, 1n]);
    expect(await logsInTimeWindows(0n, 1n, f.source)).toHaveLength(2);
    expect(f.windows).toEqual([[0n, 1n]]);
  });
  it('queries a single block once', async () => {
    const f = fixture([20n * day], [0n]);
    expect(await logsInTimeWindows(0n, 0n, f.source)).toEqual([log(0n)]);
    expect(f.reads).toEqual([0n]);
  });
  it('does not stop at empty windows or infer absence from them', async () => {
    const f = fixture([0n, 10n * day, 20n * day, 30n * day], [3n]);
    expect(await logsInTimeWindows(0n, 3n, f.source)).toEqual([log(3n)]);
    expect(f.windows).toHaveLength(4);
  });
  it('discards earlier data on query budget exhaustion', async () => {
    const f = fixture([0n, 10n * day], [0n, 1n]);
    await expect(logsInTimeWindows(0n, 1n, f.source, { maxQueries: 1 })).rejects.toMatchObject({
      code: 'history_query_budget',
    });
    expect(f.windows).toEqual([[0n, 0n]]);
  });
  it('bounds block timestamp reads before another request', async () => {
    const f = fixture([0n, 1n, 10n * day, 11n * day]);
    await expect(logsInTimeWindows(0n, 3n, f.source, { maxBlockReads: 2 })).rejects.toMatchObject({
      code: 'history_query_budget',
    });
    expect(f.reads).toHaveLength(2);
    expect(f.windows).toHaveLength(0);
  });
  it('applies the event limit to the aggregate, not each page', async () => {
    const f = fixture([0n, 10n * day], [0n, 1n]);
    await expect(logsInTimeWindows(0n, 1n, f.source, { maxLogs: 1 })).rejects.toMatchObject({ code: 'event_limit' });
  });
  it('never returns a partial result after a later RPC failure', async () => {
    const f = fixture([0n, 10n * day], [0n]);
    const query = f.source.logs;
    f.source.logs = async (a, b) => {
      if (a === 1n) throw new Error('offline');
      return query(a, b);
    };
    await expect(logsInTimeWindows(0n, 1n, f.source)).rejects.toThrow('offline');
  });
  it('rejects timestamps inconsistent with the parent interval', async () => {
    const f = fixture([0n, 30n * day, 5n * day, 10n * day]);
    await expect(logsInTimeWindows(0n, 3n, f.source)).rejects.toMatchObject({ code: 'malformed_history' });
  });
  it('rejects a response for a different block number', async () => {
    const f = fixture([0n]);
    f.source.block = async () => ({ number: 1n, timestamp: 0n });
    await expect(logsInTimeWindows(0n, 0n, f.source)).rejects.toMatchObject({ code: 'malformed_history' });
  });
  it('rejects out-of-window events instead of silently filtering them', async () => {
    const f = fixture([0n]);
    f.source.logs = async () => [log(1n)];
    await expect(logsInTimeWindows(0n, 0n, f.source)).rejects.toMatchObject({ code: 'malformed_history' });
  });
  it('does not publish a result arriving after the time budget', async () => {
    vi.useFakeTimers();
    const f = fixture([0n]);
    f.source.logs = async () => {
      vi.setSystemTime(Date.now() + 60_001);
      return [];
    };
    await expect(logsInTimeWindows(0n, 0n, f.source)).rejects.toMatchObject({ code: 'history_query_budget' });
  });
  it('rejects invalid ranges without querying the RPC', async () => {
    const f = fixture([0n]);
    await expect(logsInTimeWindows(2n, 1n, f.source)).rejects.toBeInstanceOf(ChainReadError);
    expect(f.reads).toEqual([]);
  });
  it('an error string mentioning UnknownAgreement is still an RPC failure', () => {
    const error = new Error('UnknownAgreement');
    try {
      throwAgreementReadError(error);
    } catch (actual) {
      expect(actual).toBe(error);
    }
  });
});
