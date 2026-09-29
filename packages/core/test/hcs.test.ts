import { describe, it, expect } from 'vitest';
import { keccak256, type Address, type Hex } from 'viem';
import type { NetworkResult, TrustedDeployment } from '../src/network.js';
import {
  HCS_DOMAIN,
  crossCheckHcs,
  hcsMessage,
  hcsPending,
  mirrorTopicReader,
  parseHcsMessage,
  verifyHcsTrail,
  validKey,
  HcsReadError,
  type Milestone,
  type TopicInfo,
  type TopicMessage,
  type TopicReader,
  type TrustedTopic,
} from '../src/hcs.js';

const h = (n: number) => ('0x' + n.toString(16).padStart(64, '0')) as Hex;
const address = (n: number) => ('0x' + n.toString(16).padStart(40, '0')) as Address;
const enc = (s: string) => new TextEncoder().encode(s);
const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64');

const t: TrustedDeployment = {
  chainId: 296,
  address: '0x00000000000000000000000000000000000000Ab' as Address,
  deployer: address(20),
  deploymentBlock: 1n,
  deploymentTx: h(1),
  runtimeCodeHash: keccak256('0x6000'),
};
const milestones: Milestone[] = [
  { event: 'Created', hash: h(0xa1), block: 10n, logIndex: 0 },
  { event: 'Funded', hash: h(0xa2), block: 11n, logIndex: 0 },
  { event: 'Submitted', hash: h(0xa3), block: 12n, logIndex: 1 },
  { event: 'Approved', hash: h(0xa4), block: 13n, logIndex: 0 },
  { event: 'CreditAvailable', hash: h(0xa4), block: 13n, logIndex: 1 },
];
const verified = {
  status: 'verified',
  code: 'chain_matches',
  agreement: {} as never,
  snapshot: { number: 20n, hash: h(0xff), timestamp: 1n },
  delivery: null,
  milestones,
} as NetworkResult;
const key = { type: 'ED25519' as const, key: 'ab'.repeat(32) };
const trusted: TrustedTopic = { topicId: '0.0.5005', submitKey: key };
const topic: TopicInfo = { topicId: '0.0.5005', deleted: false, submitKey: key };
const msg = (sequence: number, text: string, chunkTotal = 1): TopicMessage => ({
  topicId: '0.0.5005',
  sequence,
  consensusTimestamp: `1790665${String(sequence).padStart(3, '0')}.000000001`,
  bytes: enc(text),
  chunkTotal,
});
const all = () => milestones.map((m, i) => msg(i + 1, hcsMessage(t, 7n, m)));

describe('HCS canonical message', () => {
  it('encodes one verified event with a fixed key order and round-trips', () => {
    const text = hcsMessage(t, 7n, milestones[2]!);
    expect(text).toBe(
      `{"v":1,"domain":"${HCS_DOMAIN}","chainId":296,"contract":"0x00000000000000000000000000000000000000ab",` +
        `"agreementId":"7","event":"Submitted","tx":"${h(0xa3)}","logIndex":1,"block":"12"}`,
    );
    expect(enc(text).length).toBeLessThanOrEqual(1024);
    expect(parseHcsMessage(enc(text))).toEqual(JSON.parse(text));
  });

  it('refuses to encode invalid input', () => {
    expect(() => hcsMessage(t, 0n, milestones[0]!)).toThrow('invalid_agreement_id');
    expect(() => hcsMessage(t, 7n, { ...milestones[0]!, event: 'Paid' })).toThrow('invalid_event');
    expect(() => hcsMessage(t, 7n, { ...milestones[0]!, hash: '0x12' as Hex })).toThrow('invalid_tx');
    expect(() => hcsMessage(t, 7n, { ...milestones[0]!, logIndex: -1 })).toThrow('invalid_log_index');
    expect(() => hcsMessage({ ...t, chainId: 1 as 296 }, 7n, milestones[0]!)).toThrow('invalid_trusted_deployment');
  });

  it('accepts only the exact canonical bytes', () => {
    const text = hcsMessage(t, 7n, milestones[0]!);
    const o = JSON.parse(text);
    const variants = [
      JSON.stringify(o, null, 1),
      JSON.stringify({ domain: o.domain, ...o }),
      JSON.stringify({ ...o, extra: 1 }),
      text.replace(o.tx, o.tx.toUpperCase().replace('0X', '0x')),
      text.replace('"agreementId":"7"', '"agreementId":"07"'),
      text.replace('"agreementId":"7"', '"agreementId":"0"'),
      text.replace('"v":1', '"v":2'),
      text.replace(HCS_DOMAIN, 'DeliverProof.hcs.v2'),
      text.replace('"logIndex":0', '"logIndex":0.5'),
      text.replace('"chainId":296', '"chainId":295'),
      text + ' ',
      '[]',
      'null',
    ];
    for (const v of variants) expect(parseHcsMessage(enc(v)), v).toBeNull();
    expect(parseHcsMessage(new Uint8Array([0xff, 0xfe]))).toBeNull();
    expect(parseHcsMessage(new Uint8Array(1025).fill(0x20))).toBeNull();
    expect(parseHcsMessage(new Uint8Array())).toBeNull();
  });
});

describe('crossCheckHcs (supplemental, never a contract verdict)', () => {
  it('is consistent when every verified event has one message', () => {
    const r = crossCheckHcs(t, 7n, verified, trusted, topic, all());
    expect(r.status).toBe('consistent');
    if (r.status === 'consistent') {
      expect(r.matched.map(m => m.event)).toEqual(milestones.map(m => m.event));
      expect(r.matched.map(m => m.sequence)).toEqual([1, 2, 3, 4, 5]);
      expect(r.duplicates).toBe(0);
      expect(r.ignored).toBe(0);
    }
  });

  it('reports missing events as incomplete, never as a mismatch', () => {
    const r = crossCheckHcs(t, 7n, verified, trusted, topic, all().slice(0, 2));
    expect(r.status).toBe('incomplete');
    if (r.status === 'incomplete')
      expect(r.missing.map(m => m.event)).toEqual(['Submitted', 'Approved', 'CreditAvailable']);
    expect(crossCheckHcs(t, 7n, verified, trusted, topic, []).status).toBe('incomplete');
  });

  it('keeps the earliest sequence for a retried message and counts duplicates', () => {
    const xs = all();
    xs.push(msg(9, hcsMessage(t, 7n, milestones[1]!)));
    const r = crossCheckHcs(t, 7n, verified, trusted, topic, xs);
    expect(r.status).toBe('consistent');
    if (r.status === 'consistent') {
      expect(r.duplicates).toBe(1);
      expect(r.matched[1]!.sequence).toBe(2);
    }
  });

  it('ignores other agreements, deployments, foreign formats and chunked messages', () => {
    const other = hcsMessage(t, 8n, milestones[0]!);
    const otherContract = hcsMessage({ ...t, address: address(99) }, 7n, milestones[0]!);
    const xs = [
      msg(1, '{"hello":"world"}'),
      msg(2, other),
      msg(3, otherContract),
      msg(4, hcsMessage(t, 7n, milestones[0]!), 2),
    ];
    const tail = all().map((m, i) => ({ ...m, sequence: 10 + i }));
    const r = crossCheckHcs(t, 7n, verified, trusted, topic, [...xs, ...tail]);
    expect(r.status).toBe('consistent');
    if (r.status === 'consistent') expect(r.ignored).toBe(4);
  });

  it('is a mismatch when the trail claims an event the chain does not have', () => {
    const fake = hcsMessage(t, 7n, { event: 'Refunded', hash: h(0xb1), block: 14n, logIndex: 0 });
    expect(crossCheckHcs(t, 7n, verified, trusted, topic, [...all(), msg(6, fake)])).toEqual({
      status: 'mismatch',
      code: 'hcs_unknown_event',
    });
    const renamed = hcsMessage(t, 7n, { ...milestones[3]!, event: 'Refunded' });
    expect(crossCheckHcs(t, 7n, verified, trusted, topic, [msg(1, renamed)])).toEqual({
      status: 'mismatch',
      code: 'hcs_event_mismatch',
    });
    const moved = hcsMessage(t, 7n, { ...milestones[3]!, block: 99n });
    expect(crossCheckHcs(t, 7n, verified, trusted, topic, [msg(1, moved)])).toEqual({
      status: 'mismatch',
      code: 'hcs_event_mismatch',
    });
  });

  it('a message for an event mined after the snapshot is inconclusive, never a mismatch or a match', () => {
    // Contract read at block 20; a later real event at block 21 and its message reach the topic before
    // the HCS read. Two reads at different moments, not a divergence.
    const later: Milestone = { event: 'Withdrawn', hash: h(0xa5), block: 21n, logIndex: 0 };
    const afterSnap = msg(6, hcsMessage(t, 7n, later));
    const inconclusive = { status: 'inconclusive', code: 'hcs_after_snapshot' };
    expect(crossCheckHcs(t, 7n, verified, trusted, topic, [...all(), afterSnap])).toEqual(inconclusive);
    // Not reported as incomplete either: the trail cannot be judged until the contract is read again.
    expect(crossCheckHcs(t, 7n, verified, trusted, topic, [...all().slice(0, 2), afterSnap])).toEqual(inconclusive);
    expect(() =>
      hcsPending(t, 7n, verified, crossCheckHcs(t, 7n, verified, trusted, topic, [...all(), afterSnap])),
    ).toThrow('hcs_after_snapshot');
    // Reading the contract again at block 21 reconciles the same messages.
    const reread = {
      ...verified,
      snapshot: { number: 21n, hash: h(0xfe), timestamp: 2n },
      milestones: [...milestones, later],
    } as NetworkResult;
    expect(crossCheckHcs(t, 7n, reread, trusted, topic, [...all(), afterSnap])).toMatchObject({
      status: 'consistent',
      duplicates: 0,
    });
    // After the new read, a message the history still does not have is a divergence.
    expect(
      crossCheckHcs(t, 7n, reread, trusted, topic, [...all(), msg(6, hcsMessage(t, 7n, { ...later, hash: h(0xb2) }))]),
    ).toEqual({ status: 'mismatch', code: 'hcs_unknown_event' });
  });

  it('an invented event inside the verified range stays a mismatch, before or after a later message', () => {
    const later = msg(6, hcsMessage(t, 7n, { event: 'Withdrawn', hash: h(0xa5), block: 21n, logIndex: 0 }));
    const invented = msg(7, hcsMessage(t, 7n, { event: 'Refunded', hash: h(0xb1), block: 14n, logIndex: 0 }));
    const atSnapshot = msg(7, hcsMessage(t, 7n, { event: 'Refunded', hash: h(0xb1), block: 20n, logIndex: 0 }));
    const mismatch = { status: 'mismatch', code: 'hcs_unknown_event' };
    expect(crossCheckHcs(t, 7n, verified, trusted, topic, [...all(), later, invented])).toEqual(mismatch);
    expect(crossCheckHcs(t, 7n, verified, trusted, topic, [...all(), { ...invented, sequence: 6 }])).toEqual(mismatch);
    // The snapshot block itself is covered by the contract read.
    expect(crossCheckHcs(t, 7n, verified, trusted, topic, [...all(), later, atSnapshot])).toEqual(mismatch);
    // A known transaction and log index with another block is a mismatch even if that block is later.
    const moved = msg(6, hcsMessage(t, 7n, { ...milestones[1]!, block: 21n }));
    expect(crossCheckHcs(t, 7n, verified, trusted, topic, [...all(), moved])).toEqual({
      status: 'mismatch',
      code: 'hcs_event_mismatch',
    });
  });

  it('refuses a canonical result whose events lie after its own snapshot', () => {
    const broken = { ...verified, snapshot: { number: 12n, hash: h(0xff), timestamp: 1n } } as NetworkResult;
    expect(crossCheckHcs(t, 7n, broken, trusted, topic, all())).toEqual({
      status: 'inconclusive',
      code: 'invalid_canonical_snapshot',
    });
  });

  it('accepts only single keys in their raw mirror format', () => {
    const ed = 'ab'.repeat(32);
    const secp = '02' + 'cd'.repeat(32);
    expect(validKey({ type: 'ED25519', key: ed })).toBe(true);
    expect(validKey({ type: 'ED25519', key: ed.toUpperCase() })).toBe(true);
    expect(validKey({ type: 'ECDSA_SECP256K1', key: secp })).toBe(true);
    expect(validKey({ type: 'ECDSA_SECP256K1', key: '03' + 'cd'.repeat(32) })).toBe(true);
    const refused: unknown[] = [
      { type: 'ED25519', key: ed + 'a' }, // odd length
      { type: 'ED25519', key: ed.slice(1) }, // 63 characters
      { type: 'ED25519', key: ed + 'ab' }, // 33 bytes
      { type: 'ED25519', key: '0x' + ed },
      { type: 'ED25519', key: '302a300506032b6570032100' + ed }, // DER
      { type: 'ED25519', key: secp },
      { type: 'ECDSA_SECP256K1', key: ed }, // 32 bytes
      { type: 'ECDSA_SECP256K1', key: '04' + 'cd'.repeat(32) }, // wrong prefix
      { type: 'ECDSA_SECP256K1', key: '04' + 'cd'.repeat(64) }, // uncompressed
      { type: 'ECDSA_SECP256K1', key: secp + 'a' },
      { type: 'ECDSA_SECP256K1', key: '0x' + secp },
      { type: 'ECDSA_SECP256K1', key: '3036301006072a8648ce3d020106052b8104000a032200' + secp }, // DER
      { type: 'ECDSA', key: secp },
      { type: 'ED25519', key: 1 },
      { type: 'ED25519' },
      null,
      'ED25519',
    ];
    for (const k of refused) expect(validKey(k), JSON.stringify(k)).toBe(false);
    for (const k of refused.slice(0, 12) as TrustedTopic['submitKey'][]) {
      const tr = { ...trusted, submitKey: k };
      expect(crossCheckHcs(t, 7n, verified, tr, { ...topic, submitKey: k }, all())).toEqual({
        status: 'inconclusive',
        code: 'invalid_trusted_topic',
      });
    }
  });

  it('requires the trusted, protected, live topic', () => {
    const run = (tp: TopicInfo, tr: TrustedTopic = trusted) => crossCheckHcs(t, 7n, verified, tr, tp, all());
    expect(run({ ...topic, submitKey: null })).toEqual({ status: 'inconclusive', code: 'topic_unprotected' });
    expect(run({ ...topic, submitKey: { type: 'ProtobufEncoded' } })).toEqual({
      status: 'inconclusive',
      code: 'topic_key_unsupported',
    });
    expect(run({ ...topic, submitKey: { type: 'ED25519', key: 'cd'.repeat(32) } })).toEqual({
      status: 'mismatch',
      code: 'topic_submit_key_mismatch',
    });
    expect(run({ ...topic, submitKey: { type: 'ECDSA_SECP256K1', key: 'ab'.repeat(32) } }).status).toBe('mismatch');
    expect(run({ ...topic, submitKey: { type: 'ED25519', key: 'AB'.repeat(32) } }).status).toBe('consistent');
    expect(run({ ...topic, deleted: true })).toEqual({ status: 'inconclusive', code: 'topic_deleted' });
    expect(run({ ...topic, topicId: '0.0.6006' })).toEqual({ status: 'inconclusive', code: 'wrong_topic' });
    expect(run(topic, { ...trusted, topicId: '5005' })).toEqual({
      status: 'inconclusive',
      code: 'invalid_trusted_topic',
    });
    expect(run(topic, { ...trusted, submitKey: { type: 'ED25519', key: 'xyz' } }).status).toBe('inconclusive');
  });

  it('only runs on a verified canonical history and rejects malformed mirror data', () => {
    const bad = { status: 'mismatch', code: 'created_terms_mismatch' } as NetworkResult;
    expect(crossCheckHcs(t, 7n, bad, trusted, topic, all())).toEqual({
      status: 'inconclusive',
      code: 'canonical_not_verified',
    });
    const xs = all();
    xs[2] = { ...xs[2]!, sequence: 1 };
    expect(crossCheckHcs(t, 7n, verified, trusted, topic, xs).code).toBe('malformed_mirror_response');
    const ys = all();
    ys[0] = { ...ys[0]!, topicId: '0.0.1' };
    expect(crossCheckHcs(t, 7n, verified, trusted, topic, ys).code).toBe('malformed_mirror_response');
    const zs = all();
    zs[0] = { ...zs[0]!, consensusTimestamp: '1.2' };
    expect(crossCheckHcs(t, 7n, verified, trusted, topic, zs).code).toBe('malformed_mirror_response');
    const many = Array.from({ length: 401 }, (_, i) => msg(i + 1, 'x'));
    expect(crossCheckHcs(t, 7n, verified, trusted, topic, many)).toEqual({
      status: 'inconclusive',
      code: 'hcs_message_limit',
    });
  });

  it('lists the exact messages still to publish', () => {
    const r = crossCheckHcs(t, 7n, verified, trusted, topic, all().slice(0, 3));
    expect(hcsPending(t, 7n, verified, r)).toEqual(milestones.slice(3).map(m => hcsMessage(t, 7n, m)));
    expect(hcsPending(t, 7n, verified, crossCheckHcs(t, 7n, verified, trusted, topic, all()))).toEqual([]);
    expect(() => hcsPending(t, 7n, verified, { status: 'mismatch', code: 'hcs_unknown_event' })).toThrow(
      'hcs_unknown_event',
    );
  });
});

type Call = { url: string; init: RequestInit };
type Routes = Record<string, { status?: number; body: unknown; headers?: Record<string, string> }>;
function fakeFetch(routes: Routes) {
  const calls: Call[] = [];
  const f = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const r = routes[url];
    if (!r) return new Response('{}', { status: 404 });
    const body = typeof r.body === 'string' ? r.body : JSON.stringify(r.body);
    return new Response(body, { status: r.status ?? 200, headers: r.headers });
  }) as unknown as typeof fetch;
  return { f, calls };
}
const M = 'https://testnet.mirrornode.hedera.com';
const P = '/api/v1/topics/0.0.5005/messages?';
const mirrorMsg = (sequence: number, text: string) => ({
  chunk_info: { number: 1, total: 1 },
  consensus_timestamp: `1790665${String(sequence).padStart(3, '0')}.000000001`,
  message: b64(text),
  payer_account_id: '0.0.42',
  running_hash: 'AAAA',
  running_hash_version: 3,
  sequence_number: sequence,
  topic_id: '0.0.5005',
});

describe('mirrorTopicReader', () => {
  const texts = milestones.map(m => hcsMessage(t, 7n, m));
  const routes: Routes = {
    [`${M}/api/v1/topics/0.0.5005`]: {
      body: { topic_id: '0.0.5005', deleted: false, submit_key: { _type: 'ED25519', key: 'ab'.repeat(32) } },
    },
    [`${M}${P}limit=100&order=asc`]: {
      body: {
        messages: texts.slice(0, 3).map((x, i) => mirrorMsg(i + 1, x)),
        links: { next: `${P}limit=100&order=asc&sequencenumber=gt:3` },
      },
    },
    [`${M}${P}limit=100&order=asc&sequencenumber=gt:3`]: {
      body: { messages: texts.slice(3).map((x, i) => mirrorMsg(i + 4, x)), links: { next: null } },
    },
  };

  it('reads a protected topic across pages with bounded, credential-free requests', async () => {
    const { f, calls } = fakeFetch(routes);
    const reader = mirrorTopicReader(M, f);
    expect(await reader.topic('0.0.5005')).toEqual(topic);
    const xs = await reader.messages('0.0.5005');
    expect(xs.map(x => x.sequence)).toEqual([1, 2, 3, 4, 5]);
    expect(new TextDecoder().decode(xs[4]!.bytes)).toBe(texts[4]);
    for (const c of calls) {
      expect(c.init.redirect).toBe('error');
      expect(c.init.credentials).toBe('omit');
      expect(c.init.signal).toBeInstanceOf(AbortSignal);
    }
    expect(await verifyHcsTrail(t, 7n, verified, trusted, reader)).toMatchObject({ status: 'consistent' });
  });

  it('maps every read problem to an explicit code', async () => {
    const read = async (r: Routes, what: 'topic' | 'messages' = 'messages') => {
      const { f } = fakeFetch(r);
      try {
        await mirrorTopicReader(M, f)[what]('0.0.5005');
        return 'ok';
      } catch (e) {
        return e instanceof HcsReadError ? e.code : 'other';
      }
    };
    const first = `${M}${P}limit=100&order=asc`;
    expect(await read({ ...routes, [first]: { body: { messages: [], links: { next: '/api/v1/accounts?x' } } } })).toBe(
      'malformed_mirror_response',
    );
    expect(
      await read({ ...routes, [first]: { body: { messages: [{ ...mirrorMsg(1, 'x'), message: '!!' }], links: {} } } }),
    ).toBe('malformed_mirror_response');
    expect(await read({ ...routes, [first]: { body: '{', status: 200 } })).toBe('malformed_mirror_response');
    expect(await read({ ...routes, [first]: { body: {}, status: 503 } })).toBe('mirror_unavailable');
    expect(
      await read({ ...routes, [first]: { body: { messages: [] }, headers: { 'content-length': String(10 ** 7) } } }),
    ).toBe('mirror_limit');
    const loop: Routes = {};
    for (let i = 0; i < 5; i++)
      loop[`${M}${P}limit=100&order=asc${i ? `&p=${i}` : ''}`] = {
        body: { messages: [], links: { next: `${P}limit=100&order=asc&p=${i + 1}` } },
      };
    expect(await read(loop)).toBe('hcs_message_limit');
    expect(await read({}, 'topic')).toBe('topic_not_found');
    const protobuf = {
      body: { topic_id: '0.0.5005', deleted: false, submit_key: { _type: 'ProtobufEncoded', key: '0a' } },
    };
    const { f } = fakeFetch({ [`${M}/api/v1/topics/0.0.5005`]: protobuf });
    expect((await mirrorTopicReader(M, f).topic('0.0.5005')).submitKey).toEqual({ type: 'ProtobufEncoded' });
    expect(() => mirrorTopicReader('https://example.com' as typeof M)).toThrow('unsupported_mirror');
    const topicWith = async (submit_key: unknown) => {
      const { f: g } = fakeFetch({
        [`${M}/api/v1/topics/0.0.5005`]: { body: { topic_id: '0.0.5005', deleted: false, submit_key } },
      });
      try {
        return (await mirrorTopicReader(M, g).topic('0.0.5005')).submitKey;
      } catch (e) {
        return e instanceof HcsReadError ? e.code : 'other';
      }
    };
    const secp = '03' + 'ef'.repeat(32);
    expect(await topicWith({ _type: 'ECDSA_SECP256K1', key: secp })).toEqual({ type: 'ECDSA_SECP256K1', key: secp });
    expect(await topicWith({ _type: 'ED25519', key: 'ab'.repeat(33) })).toBe('malformed_mirror_response');
    expect(await topicWith({ _type: 'ECDSA_SECP256K1', key: 'ab'.repeat(32) })).toBe('malformed_mirror_response');
  });

  it('checks the trusted key before any mirror read', async () => {
    let reads = 0;
    const counting: TopicReader = {
      topic: async () => {
        reads++;
        return topic;
      },
      messages: async () => {
        reads++;
        return all();
      },
    };
    const bad = { ...trusted, submitKey: { type: 'ED25519' as const, key: 'ab'.repeat(32) + 'a' } };
    expect(await verifyHcsTrail(t, 7n, verified, bad, counting)).toEqual({
      status: 'inconclusive',
      code: 'invalid_trusted_topic',
    });
    expect(reads).toBe(0);
  });

  it('turns reader failures into inconclusive results', async () => {
    const failing: TopicReader = {
      topic: async () => {
        throw new HcsReadError('mirror_unavailable');
      },
      messages: async () => [],
    };
    expect(await verifyHcsTrail(t, 7n, verified, trusted, failing)).toEqual({
      status: 'inconclusive',
      code: 'mirror_unavailable',
    });
    const odd: TopicReader = {
      topic: async () => {
        throw new Error('boom');
      },
      messages: async () => [],
    };
    expect(await verifyHcsTrail(t, 7n, verified, trusted, odd)).toEqual({
      status: 'inconclusive',
      code: 'mirror_unavailable',
    });
  });
});

// Read-only check of the public testnet mirror response shape. Off by default.
describe.runIf(process.env.HCS_LIVE_TOPIC)('live testnet mirror (read-only)', () => {
  it('reads a real public topic; foreign messages are ignored', async () => {
    const id = process.env.HCS_LIVE_TOPIC!;
    const reader = mirrorTopicReader();
    const info = await reader.topic(id);
    expect(info.topicId).toBe(id);
    const first = await reader.messages(id).catch(e => (e instanceof HcsReadError ? e.code : 'other'));
    expect(first === 'hcs_message_limit' || Array.isArray(first)).toBe(true);
  }, 30000);
});
