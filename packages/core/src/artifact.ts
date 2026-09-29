import { CarWriter } from '@ipld/car';
import { CID } from 'multiformats/cid';
import { sha256 } from 'multiformats/hashes/sha2';
import { bytesToHex } from 'viem';
import { MAX_FILE_BYTES } from './delivery.js';

/** Browser-local raw-block CAR. Nothing is uploaded or pinned by this operation. */
export async function prepareArtifact(bytes: Uint8Array) {
  if (bytes.length < 1 || bytes.length > MAX_FILE_BYTES) throw new Error('File must contain 1 byte to 1 MiB.');
  const digest = await sha256.digest(bytes);
  const cid = CID.createV1(0x55, digest);
  const { writer, out } = CarWriter.create([cid]);
  const collect = (async () => {
    const chunks: Uint8Array[] = [];
    for await (const c of out) chunks.push(c);
    return chunks;
  })();
  await writer.put({ cid, bytes });
  await writer.close();
  const chunks = await collect;
  const car = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let offset = 0;
  for (const c of chunks) {
    car.set(c, offset);
    offset += c.length;
  }
  return { cid: cid.toString(), fileSha256: bytesToHex(digest.digest), fileSize: BigInt(bytes.length), car };
}
