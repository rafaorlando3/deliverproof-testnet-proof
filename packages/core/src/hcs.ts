import type { Hex } from 'viem';
import { validateDeployment, type NetworkResult, type TrustedDeployment } from './network.js';

/**
 * Supplemental Hedera Consensus Service (HCS) evidence trail.
 *
 * The contract history checked by verifyAgreement stays canonical. This module only
 * checks whether an operator-protected HCS topic carries one message for each verified
 * contract event. An HCS result never approves, pays, refunds or changes the contract
 * verdict: missing, delayed or unreadable messages are reported, nothing else.
 * Trust boundary: an independently queried mirror node, not a state proof.
 */
export const HCS_DOMAIN = 'DeliverProof.hcs.v1';
export const HCS_MIRRORS = ['https://testnet.mirrornode.hedera.com'] as const;
export type HcsMirror = (typeof HCS_MIRRORS)[number];

const MAX_MESSAGE_BYTES = 1024; // one HCS chunk; the publisher never splits a message
const PAGE_LIMIT = 100;
const MAX_PAGES = 4;
const MAX_MESSAGES = PAGE_LIMIT * MAX_PAGES;
const MAX_RESPONSE_BYTES = 512 * 1024;
const EVENTS = ['Created', 'Funded', 'Submitted', 'Approved', 'Refunded', 'CreditAvailable', 'Withdrawn'] as const;

export type Milestone = { event: string; hash: Hex; block: bigint; logIndex: number };
export type HcsKey = { type: 'ED25519' | 'ECDSA_SECP256K1'; key: string };

/** Supplied by the operator next to TrustedDeployment. Never read it from a message,
 * a query string, a wallet or an uploaded file. */
export type TrustedTopic = { topicId: string; submitKey: HcsKey };

export type HcsEntry = {
  v: 1;
  domain: typeof HCS_DOMAIN;
  chainId: 296 | 31337;
  contract: string;
  agreementId: string;
  event: (typeof EVENTS)[number];
  tx: string;
  logIndex: number;
  block: string;
};
export type TopicKey = HcsKey | { type: 'ProtobufEncoded' };
export type TopicInfo = { topicId: string; deleted: boolean; submitKey: TopicKey | null };
export type TopicMessage = {
  topicId: string;
  sequence: number;
  consensusTimestamp: string;
  bytes: Uint8Array;
  chunkTotal: number;
};
export interface TopicReader {
  topic(topicId: string): Promise<TopicInfo>;
  messages(topicId: string): Promise<TopicMessage[]>;
}
export type HcsMatch = { event: string; tx: Hex; logIndex: number; sequence: number; consensusTimestamp: string };
export type HcsResult =
  | { status: 'consistent'; code: 'hcs_matches'; matched: HcsMatch[]; duplicates: number; ignored: number }
  | {
      status: 'incomplete';
      code: 'hcs_missing_events';
      matched: HcsMatch[];
      missing: Milestone[];
      duplicates: number;
      ignored: number;
    }
  | { status: 'mismatch' | 'inconclusive'; code: string };

export class HcsReadError extends Error {
  constructor(
    readonly code:
      'mirror_unavailable' | 'mirror_limit' | 'malformed_mirror_response' | 'topic_not_found' | 'hcs_message_limit',
  ) {
    super(code);
    this.name = 'HcsReadError';
  }
}

const TOPIC_ID = /^0\.0\.[1-9][0-9]{0,15}$/;
const TX = /^0x[0-9a-f]{64}$/;
const CONTRACT = /^0x[0-9a-f]{40}$/;
const DECIMAL = /^(0|[1-9][0-9]{0,77})$/;
const TIMESTAMP = /^[0-9]{1,12}\.[0-9]{9}$/;
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
// Raw key bytes as the mirror node returns them for a single key (basic_types.proto, Key):
// ED25519 is 32 bytes; ECDSA secp256k1 is the 33-byte compressed point (02 or 03 prefix).
// DER, 0x-prefixed, uncompressed or odd-length encodings are refused.
const ED25519_HEX = /^[0-9a-f]{64}$/i;
const SECP256K1_HEX = /^0[23][0-9a-f]{64}$/i;

export const validTopicId = (x: unknown): x is string => typeof x === 'string' && TOPIC_ID.test(x);
export const validKey = (k: unknown): k is HcsKey => {
  if (!k || typeof k !== 'object') return false;
  const { type, key } = k as HcsKey;
  if (typeof key !== 'string') return false;
  if (type === 'ED25519') return ED25519_HEX.test(key);
  if (type === 'ECDSA_SECP256K1') return SECP256K1_HEX.test(key);
  return false;
};

/** Canonical message for one verified contract event. Fixed key order, no whitespace. */
export function hcsMessage(t: TrustedDeployment, id: bigint, m: Milestone): string {
  validateDeployment(t);
  if (typeof id !== 'bigint' || id < 1n || id >= 2n ** 256n) throw new Error('invalid_agreement_id');
  if (!(EVENTS as readonly string[]).includes(m.event)) throw new Error('invalid_event');
  if (typeof m.hash !== 'string' || !TX.test(m.hash.toLowerCase())) throw new Error('invalid_tx');
  if (!Number.isSafeInteger(m.logIndex) || m.logIndex < 0) throw new Error('invalid_log_index');
  if (typeof m.block !== 'bigint' || m.block < 0n) throw new Error('invalid_block');
  const entry: HcsEntry = {
    v: 1,
    domain: HCS_DOMAIN,
    chainId: t.chainId,
    contract: t.address.toLowerCase(),
    agreementId: id.toString(),
    event: m.event as HcsEntry['event'],
    tx: m.hash.toLowerCase(),
    logIndex: m.logIndex,
    block: m.block.toString(),
  };
  const text = JSON.stringify(entry);
  if (new TextEncoder().encode(text).length > MAX_MESSAGE_BYTES) throw new Error('message_too_large');
  return text;
}

/** Accepts only the exact canonical encoding. Anything else is not a DeliverProof entry. */
export function parseHcsMessage(bytes: Uint8Array): HcsEntry | null {
  if (!(bytes instanceof Uint8Array) || bytes.length === 0 || bytes.length > MAX_MESSAGE_BYTES) return null;
  let text: string;
  let x: Record<string, unknown>;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    x = JSON.parse(text);
  } catch {
    return null;
  }
  if (!x || typeof x !== 'object' || Array.isArray(x)) return null;
  const keys = ['v', 'domain', 'chainId', 'contract', 'agreementId', 'event', 'tx', 'logIndex', 'block'];
  if (Object.keys(x).join(',') !== keys.join(',')) return null;
  const ok =
    x.v === 1 &&
    x.domain === HCS_DOMAIN &&
    (x.chainId === 296 || x.chainId === 31337) &&
    typeof x.contract === 'string' &&
    CONTRACT.test(x.contract) &&
    typeof x.agreementId === 'string' &&
    DECIMAL.test(x.agreementId) &&
    x.agreementId !== '0' &&
    typeof x.event === 'string' &&
    (EVENTS as readonly string[]).includes(x.event) &&
    typeof x.tx === 'string' &&
    TX.test(x.tx) &&
    Number.isSafeInteger(x.logIndex) &&
    (x.logIndex as number) >= 0 &&
    typeof x.block === 'string' &&
    DECIMAL.test(x.block);
  if (!ok) return null;
  const entry = x as unknown as HcsEntry;
  return JSON.stringify(entry) === text ? entry : null;
}

/** Compares a protected topic with a canonical history that verifyAgreement already verified. */
export function crossCheckHcs(
  t: TrustedDeployment,
  id: bigint,
  verified: NetworkResult,
  trusted: TrustedTopic,
  topic: TopicInfo,
  messages: TopicMessage[],
): HcsResult {
  if (verified.status !== 'verified') return { status: 'inconclusive', code: 'canonical_not_verified' };
  if (
    typeof verified.snapshot?.number !== 'bigint' ||
    verified.milestones.some(m => m.block > verified.snapshot.number)
  )
    return { status: 'inconclusive', code: 'invalid_canonical_snapshot' };
  try {
    validateDeployment(t);
  } catch {
    return { status: 'inconclusive', code: 'invalid_expected_context' };
  }
  if (!validTopicId(trusted?.topicId) || !validKey(trusted?.submitKey))
    return { status: 'inconclusive', code: 'invalid_trusted_topic' };
  if (!topic || topic.topicId !== trusted.topicId) return { status: 'inconclusive', code: 'wrong_topic' };
  if (topic.deleted) return { status: 'inconclusive', code: 'topic_deleted' };
  if (!topic.submitKey) return { status: 'inconclusive', code: 'topic_unprotected' };
  if (topic.submitKey.type === 'ProtobufEncoded') return { status: 'inconclusive', code: 'topic_key_unsupported' };
  if (
    topic.submitKey.type !== trusted.submitKey.type ||
    topic.submitKey.key.toLowerCase() !== trusted.submitKey.key.toLowerCase()
  )
    return { status: 'mismatch', code: 'topic_submit_key_mismatch' };
  if (!Array.isArray(messages)) return { status: 'inconclusive', code: 'malformed_mirror_response' };
  if (messages.length > MAX_MESSAGES) return { status: 'inconclusive', code: 'hcs_message_limit' };

  const canonical = new Map<string, Milestone>();
  for (const m of verified.milestones) canonical.set(`${m.hash.toLowerCase()}:${m.logIndex}`, m);
  const contract = t.address.toLowerCase();
  const matched = new Map<string, HcsMatch>();
  let duplicates = 0;
  let ignored = 0;
  let afterSnapshot = 0;
  let last = 0;
  for (const msg of messages) {
    if (
      !msg ||
      msg.topicId !== trusted.topicId ||
      !Number.isSafeInteger(msg.sequence) ||
      msg.sequence <= last ||
      typeof msg.consensusTimestamp !== 'string' ||
      !TIMESTAMP.test(msg.consensusTimestamp)
    )
      return { status: 'inconclusive', code: 'malformed_mirror_response' };
    last = msg.sequence;
    const entry = msg.chunkTotal === 1 ? parseHcsMessage(msg.bytes) : null;
    if (!entry || entry.chainId !== t.chainId || entry.contract !== contract || entry.agreementId !== id.toString()) {
      ignored++; // other agreements, other deployments or other uses of the same topic
      continue;
    }
    const key = `${entry.tx}:${entry.logIndex}`;
    const c = canonical.get(key);
    if (!c) {
      // The contract history was read up to its snapshot block and the topic afterwards.
      // An event mined after the snapshot, and its message, can appear in between: that is
      // two reads at different moments, not a proven divergence. It is never counted as a
      // match either; the caller reads the contract again and repeats the check.
      if (BigInt(entry.block) > verified.snapshot.number) {
        afterSnapshot++;
        continue;
      }
      return { status: 'mismatch', code: 'hcs_unknown_event' };
    }
    if (c.event !== entry.event || c.block.toString() !== entry.block)
      return { status: 'mismatch', code: 'hcs_event_mismatch' };
    if (matched.has(key)) {
      duplicates++; // a retried publish; the earliest sequence stays the reference
      continue;
    }
    matched.set(key, {
      event: c.event,
      tx: c.hash,
      logIndex: c.logIndex,
      sequence: msg.sequence,
      consensusTimestamp: msg.consensusTimestamp,
    });
  }
  if (afterSnapshot) return { status: 'inconclusive', code: 'hcs_after_snapshot' };
  const list = verified.milestones
    .map(m => matched.get(`${m.hash.toLowerCase()}:${m.logIndex}`))
    .filter((x): x is HcsMatch => !!x);
  const missing = verified.milestones.filter(m => !matched.has(`${m.hash.toLowerCase()}:${m.logIndex}`));
  if (missing.length)
    return { status: 'incomplete', code: 'hcs_missing_events', matched: list, missing, duplicates, ignored };
  return { status: 'consistent', code: 'hcs_matches', matched: list, duplicates, ignored };
}

/** The canonical messages still missing from the topic, in contract order. */
export function hcsPending(t: TrustedDeployment, id: bigint, verified: NetworkResult, check: HcsResult): string[] {
  if (verified.status !== 'verified') throw new Error('canonical_not_verified');
  if (check.status === 'consistent') return [];
  if (check.status !== 'incomplete') throw new Error(check.code);
  return check.missing.map(m => hcsMessage(t, id, m));
}

async function readBounded(response: Response): Promise<string> {
  if (!response.body) throw new HcsReadError('mirror_unavailable');
  if (Number(response.headers.get('content-length')) > MAX_RESPONSE_BYTES) {
    await response.body.cancel();
    throw new HcsReadError('mirror_limit');
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const item = await reader.read();
      if (item.done) break;
      length += item.value.length;
      if (length > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new HcsReadError('mirror_limit');
      }
      chunks.push(item.value);
    }
  } finally {
    reader.releaseLock();
  }
  const all = new Uint8Array(length);
  let offset = 0;
  for (const c of chunks) {
    all.set(c, offset);
    offset += c.length;
  }
  return new TextDecoder('utf-8', { fatal: true }).decode(all);
}

function base64Bytes(s: unknown): Uint8Array {
  if (typeof s !== 'string' || s.length > 4 * Math.ceil(MAX_MESSAGE_BYTES / 3) + 4 || !BASE64.test(s))
    throw new HcsReadError('malformed_mirror_response');
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Bounded mirror-node reads: allowlisted host, no credentials, no redirects, fixed paths. */
export function mirrorTopicReader(mirror: HcsMirror = HCS_MIRRORS[0], fetcher: typeof fetch = fetch): TopicReader {
  if (!(HCS_MIRRORS as readonly string[]).includes(mirror)) throw new Error('unsupported_mirror');
  async function get(path: string): Promise<Record<string, unknown>> {
    let response: Response;
    try {
      response = await fetcher(mirror + path, {
        headers: { Accept: 'application/json' },
        credentials: 'omit',
        redirect: 'error',
        signal: AbortSignal.timeout(10000),
      });
    } catch {
      throw new HcsReadError('mirror_unavailable');
    }
    if (response.status === 404) {
      await response.body?.cancel();
      throw new HcsReadError('topic_not_found');
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new HcsReadError('mirror_unavailable');
    }
    let body: unknown;
    try {
      body = JSON.parse(await readBounded(response));
    } catch (e) {
      if (e instanceof HcsReadError) throw e;
      throw new HcsReadError('malformed_mirror_response');
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new HcsReadError('malformed_mirror_response');
    return body as Record<string, unknown>;
  }
  return {
    async topic(topicId) {
      if (!validTopicId(topicId)) throw new HcsReadError('malformed_mirror_response');
      const x = await get(`/api/v1/topics/${topicId}`);
      const k = x.submit_key as { _type?: unknown; key?: unknown } | null | undefined;
      if (x.topic_id !== topicId || typeof x.deleted !== 'boolean') throw new HcsReadError('malformed_mirror_response');
      let submitKey: TopicKey | null = null;
      if (k !== null && k !== undefined) {
        const candidate = { type: k._type, key: k.key };
        // A ProtobufEncoded (threshold or key list) submit key is not a single trusted key here.
        if (validKey(candidate)) submitKey = candidate;
        else if (k._type === 'ProtobufEncoded') submitKey = { type: 'ProtobufEncoded' };
        else throw new HcsReadError('malformed_mirror_response');
      }
      return { topicId, deleted: x.deleted, submitKey };
    },
    async messages(topicId) {
      if (!validTopicId(topicId)) throw new HcsReadError('malformed_mirror_response');
      const base = `/api/v1/topics/${topicId}/messages?`;
      let path: string | null = `${base}limit=${PAGE_LIMIT}&order=asc`;
      const out: TopicMessage[] = [];
      for (let page = 0; path; page++) {
        if (page === MAX_PAGES) throw new HcsReadError('hcs_message_limit');
        const x = await get(path);
        if (!Array.isArray(x.messages) || x.messages.length > PAGE_LIMIT)
          throw new HcsReadError('malformed_mirror_response');
        for (const m of x.messages as Record<string, unknown>[]) {
          const chunk = m?.chunk_info as { total?: unknown } | null | undefined;
          const chunkTotal = chunk === null || chunk === undefined ? 1 : chunk.total;
          if (
            !m ||
            m.topic_id !== topicId ||
            !Number.isSafeInteger(m.sequence_number) ||
            typeof m.consensus_timestamp !== 'string' ||
            !TIMESTAMP.test(m.consensus_timestamp) ||
            !Number.isSafeInteger(chunkTotal)
          )
            throw new HcsReadError('malformed_mirror_response');
          out.push({
            topicId,
            sequence: m.sequence_number as number,
            consensusTimestamp: m.consensus_timestamp,
            bytes: base64Bytes(m.message),
            chunkTotal: chunkTotal as number,
          });
        }
        const links = x.links as { next?: unknown } | undefined;
        const next = links?.next ?? null;
        if (next !== null && (typeof next !== 'string' || !next.startsWith(base)))
          throw new HcsReadError('malformed_mirror_response');
        path = next as string | null;
      }
      return out;
    },
  };
}

/** Reads the topic and compares it; every read failure is inconclusive, never a verdict. */
export async function verifyHcsTrail(
  t: TrustedDeployment,
  id: bigint,
  verified: NetworkResult,
  trusted: TrustedTopic,
  reader: TopicReader,
): Promise<HcsResult> {
  if (verified.status !== 'verified') return { status: 'inconclusive', code: 'canonical_not_verified' };
  if (!validTopicId(trusted?.topicId) || !validKey(trusted?.submitKey))
    return { status: 'inconclusive', code: 'invalid_trusted_topic' };
  try {
    const topic = await reader.topic(trusted.topicId);
    const messages = await reader.messages(trusted.topicId);
    return crossCheckHcs(t, id, verified, trusted, topic, messages);
  } catch (e) {
    if (e instanceof HcsReadError) return { status: 'inconclusive', code: e.code };
    return { status: 'inconclusive', code: 'mirror_unavailable' };
  }
}
