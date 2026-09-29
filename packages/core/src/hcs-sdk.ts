import {
  AccountId,
  Client,
  Hbar,
  PrivateKey,
  TopicCreateTransaction,
  TopicId,
  TopicMessageSubmitTransaction,
} from '@hiero-ledger/sdk';
import type { HcsKey } from './hcs.js';
import { validKey, validTopicId } from './hcs.js';
import { HcsPublishError, hederaStatus, validTransactionId, type TopicWriter } from './hcs-publish.js';

/**
 * Hedera testnet TopicWriter built on the Hiero JavaScript SDK.
 *
 * The operator account pays and its key is also the topic submit key, so one signature
 * covers both. The private key comes from the caller (read it from the process environment),
 * stays in this closure and never appears in a result, an error or a log line. Errors carry
 * only a code and, when the network returned one that is on HEDERA_TOPIC_STATUSES, the Hedera
 * status name. Every field read from the executor, its errors or the config happens inside a
 * guard, so a throwing getter or toString cannot carry a raw error out of this module.
 */
export type SdkWriterConfig = {
  network: 'testnet';
  operatorId: string;
  operatorKeyType: HcsKey['type'];
  /** Raw hex private key (32 bytes, optional 0x). Never logged or returned. */
  operatorKey: string;
};

export type ReceiptData = { status: string; transactionId: string; topicId: string | null; sequence: number | null };
/** Runs a frozen transaction and returns its receipt fields. Replaced in tests. */
export type Executor = (
  tx: TopicCreateTransaction | TopicMessageSubmitTransaction,
  client: Client,
) => Promise<ReceiptData>;

const ACCOUNT_ID = /^0\.0\.[1-9][0-9]{0,15}$/;
const RAW_KEY = /^(0x)?[0-9a-f]{64}$/i;
const MAX_FEE = new Hbar(2);

/** The listed Hedera status of a thrown SDK error, or undefined. Never throws. */
function statusOf(e: unknown): string | undefined {
  try {
    if (!e || (typeof e !== 'object' && typeof e !== 'function')) return undefined;
    const raw: unknown = (e as { status?: unknown }).status;
    if (typeof raw === 'string') return hederaStatus(raw);
    if (!raw || typeof raw !== 'object') return undefined;
    const toStr: unknown = (raw as { toString?: unknown }).toString;
    return typeof toStr === 'function' ? hederaStatus(toStr.call(raw)) : undefined;
  } catch {
    return undefined;
  }
}

export const sdkExecutor: Executor = async (tx, client) => {
  const response = await tx.execute(client);
  const receipt = await response.getReceipt(client);
  const sequence = receipt.topicSequenceNumber ? Number(receipt.topicSequenceNumber.toString()) : null;
  return {
    status: receipt.status.toString(),
    transactionId: response.transactionId.toString(),
    topicId: receipt.topicId ? receipt.topicId.toString() : null,
    sequence,
  };
};

/** Builds the topic creation: submit key only, no admin key, so nobody can delete the
 * topic or swap its submit key later. */
export function buildCreateTopic(submitKey: PrivateKey, memo: string): TopicCreateTransaction {
  return new TopicCreateTransaction().setSubmitKey(submitKey.publicKey).setTopicMemo(memo);
}

/** Builds one single-chunk submission; a canonical message never needs more than one chunk. */
export function buildSubmit(topicId: string, message: Uint8Array): TopicMessageSubmitTransaction {
  return new TopicMessageSubmitTransaction()
    .setTopicId(TopicId.fromString(topicId))
    .setMessage(message)
    .setMaxChunks(1);
}

export function sdkTopicWriter(
  config: SdkWriterConfig,
  execute: Executor = sdkExecutor,
): TopicWriter & { close(): void } {
  // Read each config field once, inside a guard.
  let network: unknown;
  let operatorId: unknown;
  let keyType: unknown;
  let rawKey: unknown;
  try {
    ({ network, operatorId, operatorKeyType: keyType, operatorKey: rawKey } = config);
  } catch {
    throw new HcsPublishError('writer_unavailable');
  }
  if (network !== 'testnet') throw new HcsPublishError('writer_unavailable');
  if (typeof operatorId !== 'string' || !ACCOUNT_ID.test(operatorId)) throw new HcsPublishError('writer_unavailable');
  if (typeof rawKey !== 'string' || !RAW_KEY.test(rawKey)) throw new HcsPublishError('writer_unavailable');
  if (keyType !== 'ECDSA_SECP256K1' && keyType !== 'ED25519') throw new HcsPublishError('writer_unavailable');
  let key: PrivateKey;
  try {
    const hex = rawKey.replace(/^0x/i, '');
    key = keyType === 'ECDSA_SECP256K1' ? PrivateKey.fromStringECDSA(hex) : PrivateKey.fromStringED25519(hex);
  } catch {
    throw new HcsPublishError('writer_unavailable');
  }
  const publicKey: HcsKey = { type: keyType, key: key.publicKey.toStringRaw().toLowerCase() };
  if (!validKey(publicKey)) throw new HcsPublishError('writer_unavailable');

  const client = Client.forTestnet();
  client.setOperator(AccountId.fromString(operatorId), key);
  client.setDefaultMaxTransactionFee(MAX_FEE);
  client.setMaxAttempts(5);
  client.setRequestTimeout(30_000);

  type Fields = { status: unknown; transactionId: unknown; topicId: unknown; sequence: unknown };
  async function run(
    tx: TopicCreateTransaction | TopicMessageSubmitTransaction,
    failure: 'create_failed' | 'submit_failed',
  ): Promise<Fields> {
    let r: unknown;
    try {
      r = await execute(tx, client);
    } catch (e) {
      throw new HcsPublishError(failure, statusOf(e));
    }
    // The transaction may have reached consensus: an unreadable receipt is malformed, not a failure.
    let f: Fields;
    try {
      const { status, transactionId, topicId, sequence } = r as Fields;
      f = { status, transactionId, topicId, sequence };
    } catch {
      throw new HcsPublishError('malformed_receipt');
    }
    if (f.status !== 'SUCCESS') throw new HcsPublishError(failure, f.status);
    return f;
  }

  return {
    submitKey: () => ({ ...publicKey }),
    async createTopic(memo) {
      if (typeof memo !== 'string' || new TextEncoder().encode(memo).length > 100)
        throw new HcsPublishError('create_failed');
      const r = await run(buildCreateTopic(key, memo), 'create_failed');
      if (!validTopicId(r.topicId)) throw new HcsPublishError('malformed_receipt');
      return { topicId: r.topicId };
    },
    async submit(topicId, message) {
      if (!validTopicId(topicId) || !(message instanceof Uint8Array) || message.length === 0 || message.length > 1024)
        throw new HcsPublishError('submit_failed');
      const r = await run(buildSubmit(topicId, message), 'submit_failed');
      if (!Number.isSafeInteger(r.sequence) || (r.sequence as number) < 1 || !validTransactionId(r.transactionId))
        throw new HcsPublishError('malformed_receipt');
      return { sequence: r.sequence as number, transactionId: r.transactionId };
    },
    close: () => client.close(),
  };
}
