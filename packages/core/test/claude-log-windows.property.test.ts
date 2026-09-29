// Revisão do Claude (M2c): propriedade do paginador por timestamp, independente dos fixtures do Codex.
// Cadeias aleatórias (semente fixa) com cadência irregular e saltos de vários dias. A fonte faz o papel do
// relay: recusa faixa com mais de 7 dias (fim do bloco final menos início do inicial, com 2 s de folga
// como no relay) e devolve só os logs da faixa. O resultado tem de ser exatamente os logs da cadeia.
import { describe, it, expect } from 'vitest';
import type { Hex } from 'viem';
import { logsInTimeWindows } from '../src/log-windows.js';
import type { ChainLog } from '../src/network.js';

function mulberry32(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const DAY = 86_400n;
function chain(rand: () => number) {
  const n = 1 + Math.floor(rand() * 400);
  const times: bigint[] = [];
  let t = 1_700_000_000n;
  for (let i = 0; i < n; i++) {
    const r = rand();
    t +=
      r < 0.05
        ? 8n * DAY + BigInt(Math.floor(rand() * 1000))
        : r < 0.2
          ? BigInt(Math.floor(rand() * 3 * 86_400))
          : BigInt(Math.floor(rand() * 5));
    times.push(t);
  }
  const logs: ChainLog[] = [];
  for (let b = 0; b < n; b++)
    if (rand() < 0.1)
      logs.push({
        address: '0x0000000000000000000000000000000000000001',
        topics: [],
        data: '0x',
        transactionHash: `0x${b.toString(16).padStart(64, '0')}` as Hex,
        blockNumber: BigInt(b),
        blockHash: `0x${'1'.padStart(64, '0')}` as Hex,
        logIndex: 0,
        removed: false,
      });
  return { times, logs };
}
function source(c: ReturnType<typeof chain>, opts: { failFrom?: bigint } = {}) {
  const queries: [bigint, bigint][] = [];
  return {
    queries,
    src: {
      block: async (n: bigint) => ({ number: n, timestamp: c.times[Number(n)]! }),
      logs: async (from: bigint, to: bigint) => {
        if (c.times[Number(to)]! + 2n - c.times[Number(from)]! > 7n * DAY) throw new Error('TIMESTAMP_RANGE_TOO_LARGE');
        if (opts.failFrom !== undefined && to >= opts.failFrom) throw new Error('ECONNRESET');
        queries.push([from, to]);
        return c.logs.filter(l => l.blockNumber >= from && l.blockNumber <= to);
      },
    },
  };
}

describe('Claude: paginador por timestamp em 300 cadeias aleatórias', () => {
  it('cobre cada bloco uma vez, em ordem, com toda janela aceita pelo relay, e devolve exatamente os logs', async () => {
    const rand = mulberry32(20260928);
    let windows = 0,
      gaps = 0;
    for (let k = 0; k < 300; k++) {
      const c = chain(rand);
      const to = BigInt(c.times.length - 1);
      gaps += c.times.some((t, i) => i > 0 && t - c.times[i - 1]! > 7n * DAY) ? 1 : 0;
      const { queries, src } = source(c);
      const got = await logsInTimeWindows(0n, to, src, { maxQueries: 1000, maxBlockReads: 5000, maxLogs: 1000 });
      expect(got).toEqual(c.logs);
      let next = 0n;
      for (const [a, b] of queries) {
        expect(a).toBe(next);
        expect(b).toBeGreaterThanOrEqual(a);
        next = b + 1n;
      }
      expect(next).toBe(to + 1n);
      windows += queries.length;
    }
    expect(gaps).toBeGreaterThan(20); // a amostra tem mesmo saltos maiores que 7 dias
    expect(windows).toBeGreaterThan(300);
  });
  it('falha em qualquer janela depois da primeira: rejeita tudo, nunca devolve parte', async () => {
    const rand = mulberry32(7);
    let tried = 0;
    for (let k = 0; k < 200 && tried < 40; k++) {
      const c = chain(rand);
      const to = BigInt(c.times.length - 1);
      const probe = source(c);
      await logsInTimeWindows(0n, to, probe.src, { maxQueries: 1000, maxBlockReads: 5000, maxLogs: 1000 });
      if (probe.queries.length < 2) continue;
      tried++;
      const last = probe.queries[probe.queries.length - 1]![0];
      await expect(
        logsInTimeWindows(0n, to, source(c, { failFrom: last }).src, {
          maxQueries: 1000,
          maxBlockReads: 5000,
          maxLogs: 1000,
        }),
      ).rejects.toThrow();
    }
    expect(tried).toBe(40);
  });
});
