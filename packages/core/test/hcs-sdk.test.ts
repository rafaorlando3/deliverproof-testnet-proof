// SDK adapter with a fake executor: the writer builds real Hiero SDK transaction objects and
// the fake executor only inspects them. It does not freeze, sign, serialize or call
// sdkExecutor. The separate "offline freeze" block freezes, signs and serializes the same
// builders without a network. None of this is a signature accepted by, or a submission to,
// a real network. Keys are generated per run; none is stored in the repository.
import { afterEach, describe, it, expect } from 'vitest';
import { keccak256, type Address, type Hex } from 'viem';
import {
  AccountId,
  Client,
  PrivateKey,
  Status,
  TopicCreateTransaction,
  TopicMessageSubmitTransaction,
  Transaction,
} from '@hiero-ledger/sdk';
import type { NetworkResult, TrustedDeployment } from '../src/network.js';
import { hcsMessage, validKey, type Milestone, type TopicMessage, type TopicReader } from '../src/hcs.js';
import { HEDERA_TOPIC_STATUSES, HcsPublishError, createHcsTopic, publishHcsTrail } from '../src/hcs-publish.js';
import { buildCreateTopic, buildSubmit, sdkTopicWriter, type Executor, type ReceiptData } from '../src/hcs-sdk.js';

const writers: { close(): void }[] = [];
afterEach(() => {
  while (writers.length) writers.pop()!.close();
});
const track = <T extends { close(): void }>(w: T) => (writers.push(w), w);
const ecdsa = () => PrivateKey.generateECDSA();
const hex = (k: PrivateKey) => k.toStringRaw();

type Sent = { tx: TopicCreateTransaction | TopicMessageSubmitTransaction };
function recorder(reply: (tx: Sent['tx'], n: number) => ReceiptData | Promise<ReceiptData>) {
  const sent: Sent[] = [];
  const execute: Executor = async tx => {
    sent.push({ tx });
    return reply(tx, sent.length);
  };
  return { sent, execute };
}

describe('transaction builders', () => {
  it('topic creation: submit key is the operator public key, no admin key, protocol memo', () => {
    const k = ecdsa();
    const tx = buildCreateTopic(k, 'DeliverProof.hcs.v1');
    expect(tx.submitKey?.toString()).toBe(k.publicKey.toString());
    expect(tx.adminKey).toBeNull();
    expect(tx.topicMemo).toBe('DeliverProof.hcs.v1');
  });

  it('submission: one chunk, exact bytes, parsed topic id', () => {
    const bytes = new TextEncoder().encode('{"v":1}');
    const tx = buildSubmit('0.0.5005', bytes);
    expect(tx.topicId?.toString()).toBe('0.0.5005');
    expect(tx.maxChunks).toBe(1);
    expect(Array.from(tx.message ?? [])).toEqual(Array.from(bytes));
  });
});

describe('sdkTopicWriter', () => {
  it('exposes only the public key, in the raw form the mirror node reports', () => {
    const k = ecdsa();
    const w = track(
      sdkTopicWriter({
        network: 'testnet',
        operatorId: '0.0.4242',
        operatorKeyType: 'ECDSA_SECP256K1',
        operatorKey: '0x' + hex(k),
      }),
    );
    const pub = w.submitKey();
    expect(validKey(pub)).toBe(true);
    expect(pub).toEqual({ type: 'ECDSA_SECP256K1', key: k.publicKey.toStringRaw().toLowerCase() });
    expect(JSON.stringify(pub)).not.toContain(hex(k));
    const e = PrivateKey.generateED25519();
    const we = track(
      sdkTopicWriter({ network: 'testnet', operatorId: '0.0.4242', operatorKeyType: 'ED25519', operatorKey: hex(e) }),
    );
    expect(we.submitKey()).toEqual({ type: 'ED25519', key: e.publicKey.toStringRaw().toLowerCase() });
  });

  it('refuses a bad configuration without echoing the key', () => {
    const secret = hex(ecdsa());
    const bad = [
      { network: 'mainnet', operatorId: '0.0.4242', operatorKeyType: 'ECDSA_SECP256K1', operatorKey: secret },
      { network: 'testnet', operatorId: '4242', operatorKeyType: 'ECDSA_SECP256K1', operatorKey: secret },
      { network: 'testnet', operatorId: '0.0.4242', operatorKeyType: 'RSA', operatorKey: secret },
      { network: 'testnet', operatorId: '0.0.4242', operatorKeyType: 'ECDSA_SECP256K1', operatorKey: secret.slice(2) },
      { network: 'testnet', operatorId: '0.0.4242', operatorKeyType: 'ECDSA_SECP256K1', operatorKey: '302e' + secret },
    ];
    for (const config of bad) {
      let caught: unknown;
      try {
        sdkTopicWriter(config as never);
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(HcsPublishError);
      expect((caught as HcsPublishError).code).toBe('writer_unavailable');
      expect(String(caught) + JSON.stringify(caught)).not.toContain(secret);
    }
  });

  it('creates a topic and submits through the executor, returning receipt data', async () => {
    const k = ecdsa();
    const { sent, execute } = recorder((tx, n) =>
      tx instanceof TopicCreateTransaction
        ? { status: 'SUCCESS', transactionId: '0.0.4242@1790670000.000000001', topicId: '0.0.9001', sequence: null }
        : { status: 'SUCCESS', transactionId: `0.0.4242@1790670000.00000000${n}`, topicId: null, sequence: n - 1 },
    );
    const w = track(
      sdkTopicWriter(
        { network: 'testnet', operatorId: '0.0.4242', operatorKeyType: 'ECDSA_SECP256K1', operatorKey: hex(k) },
        execute,
      ),
    );
    expect(await createHcsTopic(w)).toEqual({ topicId: '0.0.9001', submitKey: w.submitKey() });
    const bytes = new TextEncoder().encode('hello');
    expect(await w.submit('0.0.9001', bytes)).toEqual({ sequence: 1, transactionId: '0.0.4242@1790670000.000000002' });
    expect(sent[0]!.tx).toBeInstanceOf(TopicCreateTransaction);
    expect(sent[1]!.tx).toBeInstanceOf(TopicMessageSubmitTransaction);
    expect((sent[1]!.tx as TopicMessageSubmitTransaction).maxChunks).toBe(1);
  });

  it('maps network failures to a code plus the Hedera status name only', async () => {
    const k = ecdsa();
    const secret = hex(k);
    const cases: [ReceiptData | Error, string | undefined][] = [
      [
        { status: 'INVALID_SIGNATURE', transactionId: '0.0.4242@1.1', topicId: null, sequence: null },
        'INVALID_SIGNATURE',
      ],
      [
        Object.assign(new Error(`precheck failed for ${secret}`), {
          status: { toString: () => 'INSUFFICIENT_PAYER_BALANCE' },
        }),
        'INSUFFICIENT_PAYER_BALANCE',
      ],
      [Object.assign(new Error('x'), { status: { toString: () => `weird ${secret}` } }), undefined],
      [new Error(`timeout ${secret}`), undefined],
    ];
    for (const [outcome, status] of cases) {
      const execute: Executor = async () => {
        if (outcome instanceof Error) throw outcome;
        return outcome;
      };
      const w = track(
        sdkTopicWriter(
          { network: 'testnet', operatorId: '0.0.4242', operatorKeyType: 'ECDSA_SECP256K1', operatorKey: secret },
          execute,
        ),
      );
      const e = await w.submit('0.0.9001', new TextEncoder().encode('x')).catch(x => x);
      expect(e).toBeInstanceOf(HcsPublishError);
      expect(e).toMatchObject({ code: 'submit_failed', status, message: 'submit_failed' });
      expect(JSON.stringify(e) + String(e)).not.toContain(secret);
    }
  });

  it('rejects a success receipt without a topic id or sequence', async () => {
    const k = ecdsa();
    const execute: Executor = async () => ({
      status: 'SUCCESS',
      transactionId: '0.0.4242@1.1',
      topicId: null,
      sequence: null,
    });
    const w = track(
      sdkTopicWriter(
        { network: 'testnet', operatorId: '0.0.4242', operatorKeyType: 'ECDSA_SECP256K1', operatorKey: hex(k) },
        execute,
      ),
    );
    await expect(w.createTopic('DeliverProof.hcs.v1')).rejects.toMatchObject({ code: 'malformed_receipt' });
    await expect(w.submit('0.0.9001', new TextEncoder().encode('x'))).rejects.toMatchObject({
      code: 'malformed_receipt',
    });
    await expect(w.submit('9001', new TextEncoder().encode('x'))).rejects.toMatchObject({ code: 'submit_failed' });
    await expect(w.submit('0.0.9001', new Uint8Array(1025))).rejects.toMatchObject({ code: 'submit_failed' });
  });
});

describe('publisher over the SDK writer, fake network end to end', () => {
  it('the SDK transaction objects the writer builds carry exactly the canonical messages the verifier then accepts', async () => {
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
    ];
    const verified = {
      status: 'verified',
      code: 'chain_matches',
      agreement: {} as never,
      snapshot: { number: 20n, hash: h(0xff), timestamp: 1n },
      delivery: null,
      milestones,
    } as NetworkResult;
    const topicMessages: TopicMessage[] = [];
    const execute: Executor = async tx => {
      if (tx instanceof TopicCreateTransaction)
        return {
          status: 'SUCCESS',
          transactionId: '0.0.4242@1790670000.000000001',
          topicId: '0.0.9001',
          sequence: null,
        };
      const seq = topicMessages.length + 1;
      topicMessages.push({
        topicId: tx.topicId!.toString(),
        sequence: seq,
        consensusTimestamp: `179067000${seq}.000000001`,
        bytes: tx.message!.slice(),
        chunkTotal: tx.maxChunks ?? 0,
      });
      return {
        status: 'SUCCESS',
        transactionId: `0.0.4242@1790670000.00000000${seq + 1}`,
        topicId: null,
        sequence: seq,
      };
    };
    const w = track(
      sdkTopicWriter(
        { network: 'testnet', operatorId: '0.0.4242', operatorKeyType: 'ECDSA_SECP256K1', operatorKey: hex(ecdsa()) },
        execute,
      ),
    );
    const trusted = await createHcsTopic(w);
    const reader: TopicReader = {
      topic: async topicId => ({ topicId, deleted: false, submitKey: trusted.submitKey }),
      messages: async () => topicMessages.slice(),
    };
    const r = await publishHcsTrail(t, 7n, verified, trusted, reader, w, { confirmDelayMs: 0 });
    expect(r).toMatchObject({ status: 'published', confirmed: true, check: { status: 'consistent' } });
    expect(topicMessages.map(m => new TextDecoder().decode(m.bytes))).toEqual(
      milestones.map(m => hcsMessage(t, 7n, m)),
    );
  });
});

describe('status names and error sanitization at the executor boundary', () => {
  const MARKER = 'DEADBEEF'.repeat(8);
  const writerWith = (execute: Executor) =>
    track(
      sdkTopicWriter(
        { network: 'testnet', operatorId: '0.0.4242', operatorKeyType: 'ECDSA_SECP256K1', operatorKey: hex(ecdsa()) },
        execute,
      ),
    );
  const clean = (x: unknown) => {
    const text = JSON.stringify(x) + String(x) + (x instanceof Error ? `${x.message}${x.stack ?? ''}` : '');
    expect(text).not.toContain(MARKER);
  };

  it('every listed status is a real Hiero SDK Status name, and SUCCESS is not an error status', () => {
    const sdkNames = new Set(
      Object.values(Status)
        .filter(v => v instanceof Status)
        .map(v => v.toString()),
    );
    expect(sdkNames.size).toBeGreaterThan(300);
    for (const name of HEDERA_TOPIC_STATUSES) expect(sdkNames.has(name), name).toBe(true);
    expect(HEDERA_TOPIC_STATUSES).not.toContain('SUCCESS');
    expect(Object.isFrozen(HEDERA_TOPIC_STATUSES)).toBe(true);
  });

  it('a real SDK Status object on a thrown error maps to its name', async () => {
    const w = writerWith(async () => {
      throw Object.assign(new Error('receipt'), { status: Status.InvalidSignature });
    });
    await expect(w.submit('0.0.9001', new TextEncoder().encode('x'))).rejects.toMatchObject({
      code: 'submit_failed',
      status: 'INVALID_SIGNATURE',
    });
  });

  it('unlisted names, throwing getters and throwing toString never escape, from submit or createTopic', async () => {
    const outcomes: (() => unknown)[] = [
      () => {
        throw Object.assign(new Error(MARKER), { status: { toString: () => MARKER } });
      },
      () => {
        throw Object.assign(new Error(MARKER), { status: MARKER });
      },
      () => {
        const e = new Error(MARKER);
        Object.defineProperty(e, 'status', {
          get() {
            throw new Error(MARKER);
          },
        });
        throw e;
      },
      () => {
        throw Object.assign(new Error(MARKER), {
          status: {
            toString() {
              throw new Error(MARKER);
            },
          },
        });
      },
      () => {
        throw new Proxy(
          {},
          {
            get() {
              throw new Error(MARKER);
            },
          },
        );
      },
      () => ({ status: MARKER, transactionId: '0.0.4242@1.1', topicId: null, sequence: null }),
    ];
    for (const outcome of outcomes) {
      const w = writerWith(async () => outcome() as ReceiptData);
      const sent = await w.submit('0.0.9001', new TextEncoder().encode('x')).catch(x => x);
      expect(sent).toBeInstanceOf(HcsPublishError);
      expect({ ...sent }).toEqual({ name: 'HcsPublishError', code: 'submit_failed', status: undefined });
      clean(sent);
      const created = await w.createTopic('DeliverProof.hcs.v1').catch(x => x);
      expect(created).toBeInstanceOf(HcsPublishError);
      expect({ ...created }).toEqual({ name: 'HcsPublishError', code: 'create_failed', status: undefined });
      clean(created);
    }
  });

  it('a success receipt with throwing fields or a bad transaction id is malformed, without the marker', async () => {
    const throwing = writerWith(async () => ({
      status: 'SUCCESS',
      transactionId: '0.0.4242@1.1',
      topicId: '0.0.9001',
      get sequence(): number {
        throw new Error(MARKER);
      },
    }));
    const e = await throwing.submit('0.0.9001', new TextEncoder().encode('x')).catch(x => x);
    expect(e).toMatchObject({ code: 'malformed_receipt', status: undefined });
    clean(e);
    const badId = writerWith(async () => ({ status: 'SUCCESS', transactionId: MARKER, topicId: null, sequence: 3 }));
    const e2 = await badId.submit('0.0.9001', new TextEncoder().encode('x')).catch(x => x);
    expect(e2).toMatchObject({ code: 'malformed_receipt' });
    clean(e2);
  });

  it('a config whose fields throw is refused as writer_unavailable, without the marker', () => {
    const config = {
      network: 'testnet',
      operatorId: '0.0.4242',
      operatorKeyType: 'ECDSA_SECP256K1',
      get operatorKey(): string {
        throw new Error(MARKER);
      },
    } as unknown as Parameters<typeof sdkTopicWriter>[0];
    let e: unknown;
    try {
      sdkTopicWriter(config);
    } catch (x) {
      e = x;
    }
    expect(e).toMatchObject({ code: 'writer_unavailable' });
    clean(e);
  });
});

describe('offline freeze, sign and serialize (no network)', () => {
  // Freezing needs only the operator id and the static testnet node list; nothing is sent.
  // This checks the SDK objects survive freeze/sign/bytes, not that a network accepts them.
  it('topic creation and submission freeze with the operator, carry its signature and round-trip through bytes', async () => {
    const k = ecdsa();
    const client = Client.forTestnet({ scheduleNetworkUpdate: false });
    client.setOperator(AccountId.fromString('0.0.4242'), k);
    try {
      const create = buildCreateTopic(k, 'DeliverProof.hcs.v1').freezeWith(client);
      await create.sign(k);
      const createBack = Transaction.fromBytes(create.toBytes());
      expect(createBack).toBeInstanceOf(TopicCreateTransaction);
      const c = createBack as TopicCreateTransaction;
      expect(c.submitKey?.toString()).toBe(k.publicKey.toString());
      expect(c.adminKey).toBeNull();
      expect(c.topicMemo).toBe('DeliverProof.hcs.v1');
      expect(c.transactionId?.accountId?.toString()).toBe('0.0.4242');
      expect(k.publicKey.verifyTransaction(c)).toBe(true);
      expect(ecdsa().publicKey.verifyTransaction(c)).toBe(false);

      const bytes = new TextEncoder().encode('{"v":1}');
      const submit = buildSubmit('0.0.5005', bytes).freezeWith(client);
      await submit.sign(k);
      const submitBack = Transaction.fromBytes(submit.toBytes());
      expect(submitBack).toBeInstanceOf(TopicMessageSubmitTransaction);
      const m = submitBack as TopicMessageSubmitTransaction;
      expect(m.topicId?.toString()).toBe('0.0.5005');
      expect(Array.from(m.message ?? [])).toEqual(Array.from(bytes));
      expect(k.publicKey.verifyTransaction(m)).toBe(true);
      const serialized = Buffer.from(submit.toBytes()).toString('hex');
      expect(serialized).not.toContain(k.toStringRaw());
    } finally {
      client.close();
    }
  });
});
