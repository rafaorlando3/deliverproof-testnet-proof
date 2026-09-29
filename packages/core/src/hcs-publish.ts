import type { NetworkResult, TrustedDeployment } from './network.js';
import {
  HCS_DOMAIN,
  hcsPending,
  parseHcsMessage,
  validKey,
  validTopicId,
  verifyHcsTrail,
  type HcsKey,
  type HcsResult,
  type TopicReader,
  type TrustedTopic,
} from './hcs.js';

/**
 * Publisher for the supplemental HCS evidence trail.
 *
 * It only writes the canonical messages that verifyHcsTrail reports as missing for a
 * contract history that verifyAgreement already verified. It never writes when the topic
 * is in doubt (mismatch or inconclusive), never writes anything that is not the exact
 * canonical encoding, and never changes the contract verdict. The key that signs stays
 * inside the TopicWriter; this module only sees the public submit key.
 * Run one publisher per topic. A retry after an interruption may leave a duplicate message;
 * the verifier counts duplicates and keeps the earliest sequence as the reference.
 */
const TX_ID = /^0\.0\.[1-9][0-9]{0,15}@[0-9]{1,12}\.[0-9]{1,9}$/;

export const MAX_PUBLISH_PER_RUN = 16;
export const TOPIC_MEMO = HCS_DOMAIN;

export type Submitted = { sequence: number; transactionId: string; message: string };

/** Signs and sends. Implemented by hcs-sdk.ts for Hedera testnet, or by a fake in tests. */
export interface TopicWriter {
  /** The public key that signs submissions. Never the private key. */
  submitKey(): HcsKey;
  /** Creates a topic whose submit key is submitKey() and which has no admin key. */
  createTopic(memo: string): Promise<{ topicId: string }>;
  /** Sends one single-chunk message and returns the consensus receipt data. */
  submit(topicId: string, message: Uint8Array): Promise<{ sequence: number; transactionId: string }>;
}

export const PUBLISH_ERROR_CODES = Object.freeze([
  'writer_unavailable',
  'submit_failed',
  'malformed_receipt',
  'create_failed',
] as const);
export type PublishErrorCode = (typeof PUBLISH_ERROR_CODES)[number];

/**
 * Hedera status names a topic creation or a message submission can end with. The list is
 * closed on purpose: an error keeps its status only when the name is on it, so nothing that
 * merely looks like a status (any upper-case string) can travel in the status field. The
 * test suite checks every name against the Hiero SDK Status list. Unknown names are dropped
 * and only the error code remains.
 */
export const HEDERA_TOPIC_STATUSES = Object.freeze([
  'ACCOUNT_DELETED',
  'AUTORENEW_ACCOUNT_NOT_ALLOWED',
  'AUTORENEW_DURATION_NOT_IN_RANGE',
  'BAD_ENCODING',
  'BUSY',
  'DUPLICATE_TRANSACTION',
  'FAIL_BALANCE',
  'FAIL_FEE',
  'FAIL_INVALID',
  'INSUFFICIENT_ACCOUNT_BALANCE',
  'INSUFFICIENT_PAYER_BALANCE',
  'INSUFFICIENT_TX_FEE',
  'INVALID_ACCOUNT_ID',
  'INVALID_AUTORENEW_ACCOUNT',
  'INVALID_CHUNK_NUMBER',
  'INVALID_CHUNK_TRANSACTION_ID',
  'INVALID_KEY_ENCODING',
  'INVALID_NODE_ACCOUNT',
  'INVALID_PAYER_ACCOUNT_ID',
  'INVALID_SIGNATURE',
  'INVALID_SIGNATURE_TYPE_MISMATCHING_KEY',
  'INVALID_TOPIC_ID',
  'INVALID_TOPIC_MESSAGE',
  'INVALID_TRANSACTION',
  'INVALID_TRANSACTION_BODY',
  'INVALID_TRANSACTION_DURATION',
  'INVALID_TRANSACTION_ID',
  'INVALID_TRANSACTION_START',
  'INVALID_ZERO_BYTE_IN_STRING',
  'KEY_REQUIRED',
  'MAX_ENTITIES_IN_PRICE_REGIME_HAVE_BEEN_CREATED',
  'MEMO_TOO_LONG',
  'MESSAGE_SIZE_TOO_LARGE',
  'NOT_SUPPORTED',
  'PAYER_ACCOUNT_DELETED',
  'PAYER_ACCOUNT_NOT_FOUND',
  'PLATFORM_NOT_ACTIVE',
  'PLATFORM_TRANSACTION_NOT_CREATED',
  'RECEIPT_NOT_FOUND',
  'THROTTLED_AT_CONSENSUS',
  'TOPIC_EXPIRED',
  'TRANSACTION_EXPIRED',
  'TRANSACTION_HAS_UNKNOWN_FIELDS',
  'TRANSACTION_ID_FIELD_NOT_ALLOWED',
  'TRANSACTION_OVERSIZE',
  'TRANSACTION_TOO_MANY_LAYERS',
  'UNAUTHORIZED',
  'UNKNOWN',
] as const);

const isPublishCode = (x: unknown): x is PublishErrorCode =>
  typeof x === 'string' && (PUBLISH_ERROR_CODES as readonly string[]).includes(x);

/** The status name if it is on the closed list, otherwise undefined. Never throws. */
export const hederaStatus = (x: unknown): string | undefined =>
  typeof x === 'string' && (HEDERA_TOPIC_STATUSES as readonly string[]).includes(x) ? x : undefined;

/** Hedera transaction id as the SDK prints it: payer@seconds.nanos. */
export const validTransactionId = (x: unknown): x is string => typeof x === 'string' && TX_ID.test(x);

/**
 * The only error this module and hcs-sdk.ts throw. The constructor itself enforces the
 * contract: the code is one of PUBLISH_ERROR_CODES and the status is a listed Hedera name or
 * absent. The message is the code.
 */
export class HcsPublishError extends Error {
  readonly code: PublishErrorCode;
  readonly status: string | undefined;
  constructor(code: PublishErrorCode, status?: unknown) {
    super(isPublishCode(code) ? code : 'submit_failed');
    this.name = 'HcsPublishError';
    this.code = isPublishCode(code) ? code : 'submit_failed';
    this.status = hederaStatus(status);
  }
}

/**
 * Rebuilds whatever a writer threw as a fresh HcsPublishError. Only an allowed code and a
 * listed status survive; extra fields, getters and messages are dropped, and the original
 * object is never rethrown or returned. Anything that is not an HcsPublishError, or whose
 * fields cannot be read, becomes the fallback code with no status.
 */
export function toPublishError(e: unknown, fallback: PublishErrorCode): HcsPublishError {
  let code: unknown;
  let status: unknown;
  try {
    if (e instanceof HcsPublishError) {
      code = e.code;
      status = e.status;
    }
  } catch {
    code = undefined;
    status = undefined;
  }
  return new HcsPublishError(isPublishCode(code) ? code : fallback, status);
}

export type PublishOptions = {
  /** Mirror rereads after publishing, to see the new messages. Default 6. */
  confirmAttempts?: number;
  /** Delay between rereads in milliseconds. Default 3000. */
  confirmDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
};

export type PublishResult =
  /** The topic already had one message per verified event. Nothing was written. */
  | { status: 'up_to_date'; check: HcsResult }
  /** Missing messages were written. `confirmed` is true only when a reread saw them all. */
  | { status: 'published'; submitted: Submitted[]; confirmed: boolean; check: HcsResult }
  /** A submission failed after `submitted` succeeded. Rerun after checking the topic. */
  | { status: 'interrupted'; submitted: Submitted[]; code: string; txStatus?: string }
  /** Nothing was written: the topic or the input is in doubt. */
  | { status: 'refused'; code: string };

const sameKey = (a: HcsKey, b: HcsKey) => a.type === b.type && a.key.toLowerCase() === b.key.toLowerCase();
const defaultSleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

/** Reads the writer key once and keeps only a fresh copy of its two fields. */
function writerKey(writer: TopicWriter): HcsKey | null {
  try {
    const k: unknown = writer.submitKey();
    if (!k || typeof k !== 'object') return null;
    const { type, key } = k as HcsKey;
    const copy = { type, key };
    return validKey(copy) ? copy : null;
  } catch {
    return null;
  }
}

/** Creates the protected topic. The caller records the result as the TrustedTopic. */
export async function createHcsTopic(writer: TopicWriter): Promise<TrustedTopic> {
  const submitKey = writerKey(writer);
  if (!submitKey) throw new HcsPublishError('writer_unavailable');
  let created: unknown;
  try {
    created = await writer.createTopic(TOPIC_MEMO);
  } catch (e) {
    throw toPublishError(e, 'create_failed');
  }
  // The topic may exist now; a receipt that cannot be read is malformed, not a failed creation.
  let topicId: unknown;
  try {
    topicId = (created as { topicId?: unknown } | null | undefined)?.topicId;
  } catch {
    topicId = undefined;
  }
  if (!validTopicId(topicId)) throw new HcsPublishError('malformed_receipt');
  return { topicId, submitKey };
}

/** Writes the canonical messages the protected topic is missing, then rereads it. */
export async function publishHcsTrail(
  t: TrustedDeployment,
  id: bigint,
  verified: NetworkResult,
  trusted: TrustedTopic,
  reader: TopicReader,
  writer: TopicWriter,
  options: PublishOptions = {},
): Promise<PublishResult> {
  const attempts = options.confirmAttempts ?? 6;
  const delay = options.confirmDelayMs ?? 3000;
  const sleep = options.sleep ?? defaultSleep;
  if (!Number.isSafeInteger(attempts) || attempts < 1 || attempts > 20)
    return { status: 'refused', code: 'invalid_options' };
  if (!Number.isSafeInteger(delay) || delay < 0 || delay > 60_000)
    return { status: 'refused', code: 'invalid_options' };
  if (verified.status !== 'verified') return { status: 'refused', code: 'canonical_not_verified' };
  if (!validTopicId(trusted?.topicId) || !validKey(trusted?.submitKey))
    return { status: 'refused', code: 'invalid_trusted_topic' };
  const signing = writerKey(writer);
  if (!signing) return { status: 'refused', code: 'writer_unavailable' };
  // The network would reject a wrong signature anyway; refusing here spends no fee.
  if (!sameKey(signing, trusted.submitKey)) return { status: 'refused', code: 'writer_key_mismatch' };

  const before = await verifyHcsTrail(t, id, verified, trusted, reader);
  if (before.status === 'consistent') return { status: 'up_to_date', check: before };
  if (before.status !== 'incomplete') return { status: 'refused', code: before.code };

  let pending: string[];
  try {
    pending = hcsPending(t, id, verified, before);
  } catch (e) {
    return { status: 'refused', code: e instanceof Error ? e.message : 'invalid_pending' };
  }
  if (pending.length === 0) return { status: 'refused', code: 'nothing_pending' };
  if (pending.length > MAX_PUBLISH_PER_RUN) return { status: 'refused', code: 'too_many_pending' };
  const encoded = pending.map(text => new TextEncoder().encode(text));
  // Defense in depth: every byte string must be the exact canonical encoding.
  if (encoded.some(bytes => parseHcsMessage(bytes) === null))
    return { status: 'refused', code: 'non_canonical_message' };

  const submitted: Submitted[] = [];
  let last = 0;
  for (let i = 0; i < encoded.length; i++) {
    let receipt: unknown;
    try {
      receipt = await writer.submit(trusted.topicId, encoded[i]!);
    } catch (e) {
      const err = toPublishError(e, 'submit_failed');
      return err.status
        ? { status: 'interrupted', submitted, code: err.code, txStatus: err.status }
        : { status: 'interrupted', submitted, code: err.code };
    }
    // Read each receipt field once; a getter that throws or lies twice gets no second chance.
    let sequence: unknown;
    let transactionId: unknown;
    try {
      ({ sequence, transactionId } = receipt as { sequence?: unknown; transactionId?: unknown });
    } catch {
      return { status: 'interrupted', submitted, code: 'malformed_receipt' };
    }
    if (!Number.isSafeInteger(sequence) || (sequence as number) <= last || !validTransactionId(transactionId))
      return { status: 'interrupted', submitted, code: 'malformed_receipt' };
    last = sequence as number;
    submitted.push({ sequence: last, transactionId, message: pending[i]! });
  }

  // The mirror node lags consensus by a few seconds. Reread until it shows the whole trail.
  let check: HcsResult = before;
  for (let i = 0; i < attempts; i++) {
    if (delay > 0) await sleep(delay);
    check = await verifyHcsTrail(t, id, verified, trusted, reader);
    if (check.status === 'consistent' || check.status === 'mismatch') break;
  }
  return { status: 'published', submitted, confirmed: check.status === 'consistent', check };
}
