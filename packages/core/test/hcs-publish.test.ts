import { describe, it, expect } from 'vitest';
import { keccak256, type Address, type Hex } from 'viem';
import type { NetworkResult, TrustedDeployment } from '../src/network.js';
import {
  hcsMessage,
  parseHcsMessage,
  verifyHcsTrail,
  HcsReadError,
  type Milestone,
  type TrustedTopic,
} from '../src/hcs.js';
import {
  MAX_PUBLISH_PER_RUN,
  TOPIC_MEMO,
  HcsPublishError,
  createHcsTopic,
  hederaStatus,
  publishHcsTrail,
  toPublishError,
  type TopicWriter,
} from '../src/hcs-publish.js';
import { fakeHcs } from './fake-hcs.js';

const h = (n: number) => ('0x' + n.toString(16).padStart(64, '0')) as Hex;
const t: TrustedDeployment = {
  chainId: 296,
  address: '0x00000000000000000000000000000000000000Ab' as Address,
  deployer: ('0x' + '14'.padStart(40, '0')) as Address,
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
const verifiedWith = (list: Milestone[], snapshot = 20n) =>
  ({
    status: 'verified',
    code: 'chain_matches',
    agreement: {} as never,
    snapshot: { number: snapshot, hash: h(0xff), timestamp: 1n },
    delivery: null,
    milestones: list,
  }) as NetworkResult;
const verified = verifiedWith(milestones);
const key = { type: 'ED25519' as const, key: 'ab'.repeat(32) };
const trusted: TrustedTopic = { topicId: '0.0.5005', submitKey: key };
const fast = { confirmDelayMs: 0 };
const texts = (list: Milestone[]) => list.map(m => hcsMessage(t, 7n, m));
const onTopic = (f: ReturnType<typeof fakeHcs>) => f.consensus().map(m => new TextDecoder().decode(m.bytes));

describe('publishHcsTrail: writes only what the verified history is missing', () => {
  it('empty topic: publishes every event in contract order, one chunk each, then rereads', async () => {
    const f = fakeHcs(trusted.topicId, key);
    const r = await publishHcsTrail(t, 7n, verified, trusted, f.reader, f.writer, fast);
    expect(r).toMatchObject({ status: 'published', confirmed: true, check: { status: 'consistent', duplicates: 0 } });
    if (r.status !== 'published') return;
    expect(r.submitted.map(s => s.sequence)).toEqual([1, 2, 3, 4, 5]);
    expect(r.submitted.map(s => s.message)).toEqual(texts(milestones));
    expect(onTopic(f)).toEqual(texts(milestones));
    for (const m of f.consensus()) expect(parseHcsMessage(m.bytes)).not.toBeNull();
  });

  it('partial topic: publishes only the missing events', async () => {
    const f = fakeHcs(trusted.topicId, key);
    for (const text of texts(milestones.slice(0, 2))) f.inject(text);
    const r = await publishHcsTrail(t, 7n, verified, trusted, f.reader, f.writer, fast);
    expect(r).toMatchObject({ status: 'published', confirmed: true });
    expect(f.submits).toBe(3);
    expect(onTopic(f)).toEqual(texts(milestones));
  });

  it('complete topic: writes nothing', async () => {
    const f = fakeHcs(trusted.topicId, key);
    for (const text of texts(milestones)) f.inject(text);
    const r = await publishHcsTrail(t, 7n, verified, trusted, f.reader, f.writer, fast);
    expect(r).toMatchObject({ status: 'up_to_date', check: { status: 'consistent' } });
    expect(f.submits).toBe(0);
  });

  it('messages of other agreements on the same topic are left alone', async () => {
    const f = fakeHcs(trusted.topicId, key);
    f.inject(hcsMessage(t, 8n, milestones[0]!));
    f.inject('not a DeliverProof message');
    const r = await publishHcsTrail(t, 7n, verified, trusted, f.reader, f.writer, fast);
    expect(r).toMatchObject({ status: 'published', confirmed: true, check: { ignored: 2 } });
    expect(f.submits).toBe(5);
  });
});

describe('publishHcsTrail: mirror lag', () => {
  it('rereads until the mirror shows the new messages', async () => {
    const f = fakeHcs(trusted.topicId, key, 2);
    const waits: number[] = [];
    const r = await publishHcsTrail(t, 7n, verified, trusted, f.reader, f.writer, {
      confirmDelayMs: 3000,
      sleep: async ms => void waits.push(ms),
    });
    expect(r).toMatchObject({ status: 'published', confirmed: true });
    expect(waits).toEqual([3000, 3000, 3000]);
  });

  it('gives up without claiming success when the mirror stays behind', async () => {
    const f = fakeHcs(trusted.topicId, key, 10);
    const r = await publishHcsTrail(t, 7n, verified, trusted, f.reader, f.writer, { ...fast, confirmAttempts: 2 });
    expect(r).toMatchObject({ status: 'published', confirmed: false, check: { status: 'incomplete' } });
    if (r.status === 'published') expect(r.submitted).toHaveLength(5);
  });

  it('a rerun while the mirror is still behind writes duplicates; the verifier keeps the earliest sequence', async () => {
    const f = fakeHcs(trusted.topicId, key, 10);
    const first = await publishHcsTrail(t, 7n, verified, trusted, f.reader, f.writer, { ...fast, confirmAttempts: 1 });
    expect(first).toMatchObject({ status: 'published', confirmed: false });
    f.lagReads = 0;
    const again = await publishHcsTrail(t, 7n, verified, trusted, f.reader, f.writer, { ...fast, confirmAttempts: 1 });
    expect(again).toMatchObject({ status: 'published', confirmed: false });
    expect(f.submits).toBe(10);
    for (let i = 0; i < 10; i++) await f.reader.messages(trusted.topicId); // mirror catches up
    const check = await verifyHcsTrail(t, 7n, verified, trusted, f.reader);
    expect(check).toMatchObject({ status: 'consistent', duplicates: 5 });
    if (check.status === 'consistent') expect(check.matched.map(m => m.sequence)).toEqual([1, 2, 3, 4, 5]);
  });
});

describe('publishHcsTrail: never writes on a doubtful topic or input', () => {
  const refusedWithoutWrites = async (
    f: ReturnType<typeof fakeHcs>,
    code: string,
    v: NetworkResult = verified,
    tt: TrustedTopic = trusted,
  ) => {
    const r = await publishHcsTrail(t, 7n, v, tt, f.reader, f.writer, fast);
    expect(r).toEqual({ status: 'refused', code });
    expect(f.submits).toBe(0);
  };

  it('invented event on the topic: mismatch, refused', async () => {
    const f = fakeHcs(trusted.topicId, key);
    f.inject(hcsMessage(t, 7n, { event: 'Refunded', hash: h(0xee), block: 15n, logIndex: 0 }));
    await refusedWithoutWrites(f, 'hcs_unknown_event');
  });

  it('message for an event after the snapshot: inconclusive, refused', async () => {
    const f = fakeHcs(trusted.topicId, key);
    f.inject(hcsMessage(t, 7n, { event: 'Withdrawn', hash: h(0xef), block: 21n, logIndex: 0 }));
    await refusedWithoutWrites(f, 'hcs_after_snapshot');
  });

  it('topic without submit key, deleted, or with another key: refused', async () => {
    const open = fakeHcs(trusted.topicId, key);
    open.topic.submitKey = null;
    await refusedWithoutWrites(open, 'topic_unprotected');
    const deleted = fakeHcs(trusted.topicId, key);
    deleted.topic.deleted = true;
    await refusedWithoutWrites(deleted, 'topic_deleted');
    const other = fakeHcs(trusted.topicId, key);
    other.topic.submitKey = { type: 'ED25519', key: 'cd'.repeat(32) };
    await refusedWithoutWrites(other, 'topic_submit_key_mismatch');
  });

  it('mirror unavailable: refused', async () => {
    const f = fakeHcs(trusted.topicId, key);
    f.reader.messages = async () => {
      throw new HcsReadError('mirror_unavailable');
    };
    await refusedWithoutWrites(f, 'mirror_unavailable');
  });

  it('history not verified, invalid trusted topic, or a writer with another key: refused', async () => {
    await refusedWithoutWrites(fakeHcs(trusted.topicId, key), 'canonical_not_verified', {
      status: 'inconclusive',
      code: 'rpc_unavailable',
    });
    await refusedWithoutWrites(fakeHcs(trusted.topicId, key), 'invalid_trusted_topic', verified, {
      topicId: '0.0.5005',
      submitKey: { type: 'ED25519', key: 'ab'.repeat(31) },
    });
    const f = fakeHcs(trusted.topicId, { type: 'ECDSA_SECP256K1', key: '02' + 'ab'.repeat(32) });
    await refusedWithoutWrites(f, 'writer_key_mismatch');
    const broken = fakeHcs(trusted.topicId, key);
    broken.writer.submitKey = () => {
      throw new Error('keystore locked');
    };
    await refusedWithoutWrites(broken, 'writer_unavailable');
  });

  it('more pending messages than one run allows: refused', async () => {
    const many = Array.from({ length: MAX_PUBLISH_PER_RUN + 1 }, (_, i) => ({
      event: 'Funded',
      hash: h(0x100 + i),
      block: 10n + BigInt(i),
      logIndex: 0,
    }));
    await refusedWithoutWrites(fakeHcs(trusted.topicId, key), 'too_many_pending', verifiedWith(many, 40n));
  });

  it('invalid options: refused before any read', async () => {
    const f = fakeHcs(trusted.topicId, key);
    expect(await publishHcsTrail(t, 7n, verified, trusted, f.reader, f.writer, { confirmAttempts: 0 })).toEqual({
      status: 'refused',
      code: 'invalid_options',
    });
    expect(await publishHcsTrail(t, 7n, verified, trusted, f.reader, f.writer, { confirmDelayMs: -1 })).toEqual({
      status: 'refused',
      code: 'invalid_options',
    });
    expect(f.topicReads + f.submits).toBe(0);
  });
});

describe('publishHcsTrail: interruptions', () => {
  it('failed submission: stops, reports what went through, and a rerun completes without duplicates', async () => {
    const f = fakeHcs(trusted.topicId, key);
    f.failSubmit = {
      at: 3,
      afterConsensus: false,
      error: new HcsPublishError('submit_failed', 'INSUFFICIENT_PAYER_BALANCE'),
    };
    const r = await publishHcsTrail(t, 7n, verified, trusted, f.reader, f.writer, fast);
    expect(r).toMatchObject({ status: 'interrupted', code: 'submit_failed', txStatus: 'INSUFFICIENT_PAYER_BALANCE' });
    if (r.status === 'interrupted') expect(r.submitted.map(s => s.sequence)).toEqual([1, 2]);
    f.failSubmit = undefined;
    const again = await publishHcsTrail(t, 7n, verified, trusted, f.reader, f.writer, fast);
    expect(again).toMatchObject({ status: 'published', confirmed: true, check: { duplicates: 0 } });
    expect(onTopic(f)).toEqual(texts(milestones));
  });

  it('receipt lost after consensus: the rerun sees the message and does not resend it', async () => {
    const f = fakeHcs(trusted.topicId, key);
    f.failSubmit = { at: 2, afterConsensus: true, error: new Error('socket hang up') };
    const r = await publishHcsTrail(t, 7n, verified, trusted, f.reader, f.writer, fast);
    expect(r).toEqual({
      status: 'interrupted',
      submitted: [expect.objectContaining({ sequence: 1 })],
      code: 'submit_failed',
    });
    f.failSubmit = undefined;
    const again = await publishHcsTrail(t, 7n, verified, trusted, f.reader, f.writer, fast);
    expect(again).toMatchObject({ status: 'published', confirmed: true, check: { duplicates: 0 } });
    expect(f.consensus()).toHaveLength(5);
  });

  it('error details never leak: only a code and a Hedera status name', async () => {
    const f = fakeHcs(trusted.topicId, key);
    const secret = 'ff'.repeat(32);
    f.failSubmit = { at: 1, afterConsensus: false, error: new Error(`signing failed with ${secret}`) };
    const r = await publishHcsTrail(t, 7n, verified, trusted, f.reader, f.writer, fast);
    expect(JSON.stringify(r)).not.toContain(secret);
    f.failSubmit = {
      at: 2,
      afterConsensus: false,
      error: new HcsPublishError('submit_failed', `BAD ${secret}`),
    };
    const r2 = await publishHcsTrail(t, 7n, verified, trusted, f.reader, f.writer, fast);
    expect(r2).toEqual({ status: 'interrupted', submitted: [], code: 'submit_failed' });
  });

  it('malformed receipt (sequence going back or bad transaction id): stops', async () => {
    const f = fakeHcs(trusted.topicId, key);
    const back: TopicWriter = { ...f.writer, submit: async () => ({ sequence: 0, transactionId: '0.0.1@1.1' }) };
    expect(await publishHcsTrail(t, 7n, verified, trusted, f.reader, back, fast)).toEqual({
      status: 'interrupted',
      submitted: [],
      code: 'malformed_receipt',
    });
    const badId: TopicWriter = { ...f.writer, submit: async () => ({ sequence: 1, transactionId: 'abc' }) };
    expect(await publishHcsTrail(t, 7n, verified, trusted, f.reader, badId, fast)).toMatchObject({
      status: 'interrupted',
      code: 'malformed_receipt',
    });
  });
});

describe('createHcsTopic', () => {
  it('returns the trusted topic with the writer public key and the protocol memo', async () => {
    const f = fakeHcs('0.0.7777', key);
    let memo = '';
    const writer: TopicWriter = { ...f.writer, createTopic: async m => ((memo = m), { topicId: '0.0.7777' }) };
    expect(await createHcsTopic(writer)).toEqual({ topicId: '0.0.7777', submitKey: key });
    expect(memo).toBe(TOPIC_MEMO);
  });

  it('malformed topic id, failing writer, or invalid key: typed error, no details', async () => {
    const f = fakeHcs('0.0.7777', key);
    await expect(createHcsTopic({ ...f.writer, createTopic: async () => ({ topicId: '7777' }) })).rejects.toMatchObject(
      {
        code: 'malformed_receipt',
      },
    );
    await expect(
      createHcsTopic({
        ...f.writer,
        createTopic: async () => {
          throw new Error('boom');
        },
      }),
    ).rejects.toMatchObject({ code: 'create_failed', message: 'create_failed' });
    await expect(
      createHcsTopic({ ...f.writer, submitKey: () => ({ type: 'ED25519', key: 'zz' }) }),
    ).rejects.toMatchObject({ code: 'writer_unavailable' });
  });
});

// Regressions for the Codex review of 86d4a82: a writer is outside the trust boundary. Its
// errors, receipts and key are rebuilt from allowed fields, never passed through.
describe('writer boundary: only listed codes and Hedera status names come out', () => {
  // Synthetic marker: 64 upper-case hex letters, the shape the old /^[A-Z_]{1,64}$/ accepted.
  const MARKER = 'DEADBEEF'.repeat(8);
  const clean = (x: unknown) => {
    const text = JSON.stringify(x) + String(x) + (x instanceof Error ? `${x.message}${x.stack ?? ''}` : '');
    expect(text).not.toContain(MARKER);
    expect(text).not.toContain('NOT_A_HEDERA_STATUS');
  };
  const failWith = (error: unknown) => {
    const f = fakeHcs(trusted.topicId, key);
    f.failSubmit = { at: 1, afterConsensus: false, error };
    return f;
  };

  it('a status in the accepted shape but not a Hedera name is dropped; the writer is not called again', async () => {
    for (const status of [MARKER, 'NOT_A_HEDERA_STATUS', 'SUCCESS_' + MARKER]) {
      const f = failWith(new HcsPublishError('submit_failed', status));
      const r = await publishHcsTrail(t, 7n, verified, trusted, f.reader, f.writer, fast);
      expect(r).toEqual({ status: 'interrupted', submitted: [], code: 'submit_failed' });
      expect(f.submits).toBe(1);
      clean(r);
    }
    expect(hederaStatus(MARKER)).toBeUndefined();
    expect(new HcsPublishError('submit_failed', MARKER).status).toBeUndefined();
  });

  it('listed statuses survive: INVALID_SIGNATURE and INSUFFICIENT_PAYER_BALANCE', async () => {
    for (const status of ['INVALID_SIGNATURE', 'INSUFFICIENT_PAYER_BALANCE']) {
      const f = failWith(new HcsPublishError('submit_failed', status));
      expect(await publishHcsTrail(t, 7n, verified, trusted, f.reader, f.writer, fast)).toEqual({
        status: 'interrupted',
        submitted: [],
        code: 'submit_failed',
        txStatus: status,
      });
      expect(f.submits).toBe(1);
    }
  });

  it('extra fields, an unexpected code or status, and throwing getters on the thrown error are not echoed', async () => {
    const extra = Object.assign(new HcsPublishError('submit_failed', 'INVALID_SIGNATURE'), { detail: MARKER });
    const badCode = new HcsPublishError('submit_failed', 'BUSY');
    Object.defineProperty(badCode, 'code', { value: MARKER });
    const badStatus = new HcsPublishError('submit_failed');
    Object.defineProperty(badStatus, 'status', { value: MARKER });
    const throwingStatus = new HcsPublishError('submit_failed', 'BUSY');
    Object.defineProperty(throwingStatus, 'status', {
      get() {
        throw new Error(MARKER);
      },
    });
    const throwingProto = new Proxy(
      {},
      {
        getPrototypeOf() {
          throw new Error(MARKER);
        },
      },
    );
    const cases: [unknown, object][] = [
      [extra, { code: 'submit_failed', txStatus: 'INVALID_SIGNATURE' }],
      [badCode, { code: 'submit_failed', txStatus: 'BUSY' }],
      [badStatus, { code: 'submit_failed' }],
      [throwingStatus, { code: 'submit_failed' }],
      [throwingProto, { code: 'submit_failed' }],
    ];
    for (const [error, expected] of cases) {
      const f = failWith(error);
      const r = await publishHcsTrail(t, 7n, verified, trusted, f.reader, f.writer, fast);
      expect(r).toEqual({ status: 'interrupted', submitted: [], ...expected });
      expect(f.submits).toBe(1);
      clean(r);
    }
  });

  it('a receipt whose fields throw stops as malformed, without the marker and without more submissions', async () => {
    const f = fakeHcs(trusted.topicId, key);
    let calls = 0;
    const writer: TopicWriter = {
      ...f.writer,
      submit: async () => {
        calls++;
        return {
          get sequence(): number {
            throw new Error(MARKER);
          },
          transactionId: '0.0.1@1.1',
        };
      },
    };
    const r = await publishHcsTrail(t, 7n, verified, trusted, f.reader, writer, fast);
    expect(r).toEqual({ status: 'interrupted', submitted: [], code: 'malformed_receipt' });
    expect(calls).toBe(1);
    clean(r);
  });

  it('createHcsTopic rebuilds the error instead of rethrowing the writer object', async () => {
    const f = fakeHcs('0.0.7777', key);
    const thrown = Object.assign(new HcsPublishError('create_failed', MARKER), { detail: MARKER });
    const e = await createHcsTopic({
      ...f.writer,
      createTopic: async () => {
        throw thrown;
      },
    }).catch(x => x);
    expect(e).toBeInstanceOf(HcsPublishError);
    expect(e).not.toBe(thrown);
    expect({ ...e }).toEqual({ name: 'HcsPublishError', code: 'create_failed', status: undefined });
    clean(e);
    const valid = await createHcsTopic({
      ...f.writer,
      createTopic: async () => {
        throw new HcsPublishError('create_failed', 'INSUFFICIENT_PAYER_BALANCE');
      },
    }).catch(x => x);
    expect(valid).toMatchObject({ code: 'create_failed', status: 'INSUFFICIENT_PAYER_BALANCE' });
  });

  it('createHcsTopic: a throwing topicId getter is a malformed receipt; extra key fields are not kept', async () => {
    const f = fakeHcs('0.0.7777', key);
    const e = await createHcsTopic({
      ...f.writer,
      createTopic: async () => ({
        get topicId(): string {
          throw new Error(MARKER);
        },
      }),
    }).catch(x => x);
    expect(e).toMatchObject({ code: 'malformed_receipt' });
    clean(e);
    const topic = await createHcsTopic({
      ...f.writer,
      submitKey: () => Object.assign({ ...key }, { note: MARKER }),
      createTopic: async () => ({ topicId: '0.0.7777' }),
    });
    expect(topic).toEqual({ topicId: '0.0.7777', submitKey: key });
    clean(topic);
  });

  it('toPublishError: anything but an HcsPublishError becomes the fallback code with no status', () => {
    for (const x of [new Error(MARKER), { code: 'submit_failed', status: 'BUSY' }, MARKER, null, undefined]) {
      const e = toPublishError(x, 'create_failed');
      expect({ ...e }).toEqual({ name: 'HcsPublishError', code: 'create_failed', status: undefined });
      clean(e);
    }
  });
});
