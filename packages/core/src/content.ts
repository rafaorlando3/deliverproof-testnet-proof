import { CarBlockIterator } from '@ipld/car';
import { exporter } from 'ipfs-unixfs-exporter';
import { CID } from 'multiformats/cid';
import { sha256 } from 'multiformats/hashes/sha2';
import { bytesToHex, type Hex } from 'viem';
import { deliveryCommitment, MAX_CAR_BYTES, MAX_FILE_BYTES, type Delivery } from './delivery.js';

export type ContentResult =
  | { status: 'verified'; code: 'bytes_match'; bytes: Uint8Array; commitment: Hex }
  | { status: 'mismatch'; code: string }
  | { status: 'inconclusive'; code: string };
class EvidenceError extends Error {
  constructor(
    readonly status: 'mismatch' | 'inconclusive',
    readonly code: string,
  ) {
    super(code);
  }
}
const equal = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((v, i) => v === b[i]);

/** Offline verification of a bounded CAR, including every block hash and the UnixFS DAG.
 * This proves byte correspondence, not quality, authorship, payment or availability. */
export async function verifyCar(car: Uint8Array, delivery: Delivery, expectedCommitment: Hex): Promise<ContentResult> {
  if (typeof expectedCommitment !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(expectedCommitment)) {
    return { status: 'mismatch', code: 'invalid_commitment' };
  }
  let commitment: Hex;
  try {
    commitment = deliveryCommitment(delivery);
  } catch {
    return { status: 'mismatch', code: 'invalid_delivery_metadata' };
  }
  if (commitment.toLowerCase() !== expectedCommitment.toLowerCase())
    return { status: 'mismatch', code: 'commitment_mismatch' };
  if (car.byteLength > MAX_CAR_BYTES) return { status: 'inconclusive', code: 'car_limit' };
  try {
    const root = CID.parse(delivery.cid);
    // Decode records progressively: a complete-reader index would allocate every
    // record before our limit, including repeated copies of the same CID.
    const reader = await CarBlockIterator.fromBytes(car);
    const roots = await reader.getRoots();
    if (roots.length !== 1 || !roots[0].equals(root)) return { status: 'mismatch', code: 'car_root_mismatch' };
    const blocks = new Map<string, Uint8Array>();
    let records = 0;
    for await (const { cid, bytes } of reader) {
      // Bound work, not only distinct stored CIDs. Every repeated record still
      // consumes budget and must pass hash verification before replacing a block.
      if (++records > 512) throw new EvidenceError('inconclusive', 'block_limit');
      if (cid.multihash.code !== 0x12 || cid.multihash.size !== 32 || ![0x55, 0x70].includes(cid.code)) {
        throw new EvidenceError('inconclusive', 'unsupported_block');
      }
      if (!equal((await sha256.digest(bytes)).bytes, cid.multihash.bytes))
        throw new EvidenceError('mismatch', 'block_hash_mismatch');
      blocks.set(cid.toV1().toString(), bytes);
    }
    let reads = 0;
    const store = {
      async *get(cid: CID) {
        if (++reads > 2048) throw new EvidenceError('inconclusive', 'dag_read_limit');
        const bytes = blocks.get(cid.toV1().toString());
        if (!bytes) throw new EvidenceError('inconclusive', 'missing_block');
        yield bytes;
      },
    };
    const signal = AbortSignal.timeout(5000);
    const entry = await exporter(root, store, { offline: true, signal });
    if (entry.type !== 'file' && entry.type !== 'raw') return { status: 'mismatch', code: 'not_a_file' };
    if (entry.type === 'file' && !['file', 'raw'].includes(entry.unixfs.type)) {
      return { status: 'mismatch', code: 'not_a_file' };
    }
    if (entry.size !== delivery.fileSize) return { status: 'mismatch', code: 'file_size_mismatch' };
    const result = new Uint8Array(Number(delivery.fileSize));
    let offset = 0;
    for await (const chunk of entry.content({ offline: true, signal, blockReadConcurrency: 1 })) {
      if (offset + chunk.length > result.length || offset + chunk.length > MAX_FILE_BYTES) {
        return { status: 'mismatch', code: 'file_size_mismatch' };
      }
      result.set(chunk, offset);
      offset += chunk.length;
    }
    if (offset !== result.length) return { status: 'mismatch', code: 'file_size_mismatch' };
    if (bytesToHex((await sha256.digest(result)).digest).toLowerCase() !== delivery.fileSha256.toLowerCase()) {
      return { status: 'mismatch', code: 'file_sha256_mismatch' };
    }
    return { status: 'verified', code: 'bytes_match', bytes: result, commitment };
  } catch (error) {
    if (error instanceof EvidenceError) return { status: error.status, code: error.code };
    // A gateway may send a partial/malformed archive. This is not proof against the supplier.
    return { status: 'inconclusive', code: 'unreadable_car' };
  }
}

export type Gateway = 'https://trustless-gateway.link' | 'https://ipfs.io';
const GATEWAYS: readonly string[] = ['https://trustless-gateway.link', 'https://ipfs.io'];

/** Bounded trustless gateway fetch. No credentials, arbitrary URLs or HTTP redirects. */
export async function fetchAndVerify(
  delivery: Delivery,
  expectedCommitment: Hex,
  gateway: Gateway = 'https://trustless-gateway.link',
  fetcher: typeof fetch = fetch,
): Promise<ContentResult> {
  try {
    deliveryCommitment(delivery);
  } catch {
    return { status: 'mismatch', code: 'invalid_delivery_metadata' };
  }
  if (!GATEWAYS.includes(gateway)) return { status: 'inconclusive', code: 'unsupported_gateway' };
  try {
    const response = await fetcher(`${gateway}/ipfs/${delivery.cid}?format=car&dag-scope=all`, {
      headers: { Accept: 'application/vnd.ipld.car; version=1' },
      credentials: 'omit',
      redirect: 'error',
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok || !response.body) return { status: 'inconclusive', code: 'gateway_unavailable' };
    if (Number(response.headers.get('content-length')) > MAX_CAR_BYTES) {
      await response.body.cancel();
      return { status: 'inconclusive', code: 'car_limit' };
    }
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let length = 0;
    try {
      while (true) {
        const item = await reader.read();
        if (item.done) break;
        length += item.value.length;
        if (length > MAX_CAR_BYTES) {
          await reader.cancel();
          return { status: 'inconclusive', code: 'car_limit' };
        }
        chunks.push(item.value);
      }
    } finally {
      reader.releaseLock();
    }
    const car = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      car.set(chunk, offset);
      offset += chunk.length;
    }
    return await verifyCar(car, delivery, expectedCommitment);
  } catch {
    return { status: 'inconclusive', code: 'gateway_unavailable' };
  }
}
