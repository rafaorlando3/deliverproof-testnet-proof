import { describe, it, expect } from 'vitest';
import { CID } from 'multiformats/cid';
import { sha256 } from 'multiformats/hashes/sha2';
import { CarWriter } from '@ipld/car';
import { importer } from 'ipfs-unixfs-importer';
import { fixedSize } from 'ipfs-unixfs-importer/chunker';
import { bytesToHex, type Hex } from 'viem';
import { deliveryCommitment, rpcValueForTinybars, MAX_CAR_BYTES, type Delivery } from '../src/delivery.js';
import { verifyCar, fetchAndVerify } from '../src/content.js';
import { inspectTransaction } from '../src/receipt.js';

const h = `0x${'11'.repeat(32)}` as Hex;
async function archive(root: CID, blocks: { cid: CID; bytes: Uint8Array }[]) {
  const { writer, out } = CarWriter.create([root]);
  const consume = (async () => {
    const chunks: Uint8Array[] = [];
    let size = 0;
    for await (const b of out) {
      chunks.push(b);
      size += b.length;
    }
    const result = new Uint8Array(size);
    let offset = 0;
    for (const b of chunks) {
      result.set(b, offset);
      offset += b.length;
    }
    return result;
  })();
  for (const b of blocks) await writer.put(b);
  await writer.close();
  return consume;
}
async function fixture() {
  const bytes = new TextEncoder().encode('Public synthetic report. No personal data.\n');
  const digest = await sha256.digest(bytes);
  const cid = CID.createV1(0x55, digest);
  const delivery: Delivery = {
    chainId: 296,
    contract: '0x1111111111111111111111111111111111111111',
    agreementId: 1n,
    termsHash: h,
    cid: cid.toString(),
    fileSha256: bytesToHex(digest.digest),
    fileSize: BigInt(bytes.length),
    mediaType: 1,
    version: 1,
  };
  return { bytes, cid, delivery, car: await archive(cid, [{ cid, bytes }]), commitment: deliveryCommitment(delivery) };
}

/** Blockstore mínimo que guarda o CID exatamente como o importer o gravou (codec incluso). */
function recordingStore() {
  const blocks: { cid: CID; bytes: Uint8Array }[] = [];
  const byKey = new Map<string, Uint8Array>();
  async function collect(v: any): Promise<Uint8Array> {
    if (v instanceof Uint8Array) return v;
    const chunks: Uint8Array[] = [];
    let size = 0;
    for await (const b of v) {
      chunks.push(b);
      size += b.length;
    }
    const out = new Uint8Array(size);
    let o = 0;
    for (const b of chunks) {
      out.set(b, o);
      o += b.length;
    }
    return out;
  }
  return {
    blocks,
    async put(cid: CID, v: any) {
      const bytes = await collect(v);
      if (!byKey.has(cid.toString())) {
        byKey.set(cid.toString(), bytes);
        blocks.push({ cid, bytes });
      }
      return cid;
    },
    async *get(cid: CID) {
      const b = byKey.get(cid.toString());
      if (!b) throw new Error('not found');
      yield b;
    },
    async has(cid: CID) {
      return byKey.has(cid.toString());
    },
  };
}

describe('content proof', () => {
  it('verifies a raw block without trusting the gateway', async () => {
    const f = await fixture();
    const result = await verifyCar(f.car, f.delivery, f.commitment);
    expect(result.status).toBe('verified');
    if (result.status === 'verified') expect(result.bytes).toEqual(f.bytes);
  });
  it('reconstructs and verifies a multi-block UnixFS DAG, not a CID-as-file-hash shortcut', async () => {
    // Claude (revisão M1): MemoryBlockstore.getAll() devolve toda chave com o codec raw (0x55), inclusive
    // a raiz dag-pb, e o CAR montado a partir dele não tinha o bloco dag-pb. O verificador acertava ao dizer
    // "inconclusive"; o defeito era do fixture. Aqui os blocos são gravados com o CID que o importer usou.
    const f = await fixture();
    const store = recordingStore();
    let root: CID | undefined;
    for await (const entry of importer([{ content: f.bytes }], store as any, {
      cidVersion: 1,
      rawLeaves: true,
      chunker: fixedSize({ chunkSize: 8 }),
    }))
      root = entry.cid;
    expect(root).toBeDefined();
    const blocks = store.blocks;
    expect(blocks.some(b => b.cid.code === 0x70)).toBe(true);
    expect(blocks.length).toBeGreaterThan(1);
    const d = { ...f.delivery, cid: root!.toString() };
    expect(root!.multihash.digest).not.toEqual((await sha256.digest(f.bytes)).digest);
    const result = await verifyCar(await archive(root!, blocks), d, deliveryCommitment(d));
    expect(result.status).toBe('verified');
    if (result.status === 'verified') expect(result.bytes).toEqual(f.bytes);
    const missing = await verifyCar(
      await archive(
        root!,
        blocks.filter(b => b.cid.equals(root!)),
      ),
      d,
      deliveryCommitment(d),
    );
    expect(missing.status).toBe('inconclusive');
  });
  it('CAR whose dag-pb root block is labeled raw is inconclusive (missing_block), never verified (Claude, revisão M1)', async () => {
    const f = await fixture();
    const store = recordingStore();
    let root: CID | undefined;
    for await (const entry of importer([{ content: f.bytes }], store as any, {
      cidVersion: 1,
      rawLeaves: true,
      chunker: fixedSize({ chunkSize: 8 }),
    }))
      root = entry.cid;
    const relabeled = store.blocks.map(b => ({ cid: CID.createV1(0x55, b.cid.multihash), bytes: b.bytes }));
    const d = { ...f.delivery, cid: root!.toString() };
    expect(await verifyCar(await archive(root!, relabeled), d, deliveryCommitment(d))).toEqual({
      status: 'inconclusive',
      code: 'missing_block',
    });
  });
  it('detects a gateway block whose bytes do not match its claimed CID', async () => {
    const f = await fixture();
    const bad = f.bytes.slice();
    bad[0] ^= 1;
    expect(await verifyCar(await archive(f.cid, [{ cid: f.cid, bytes: bad }]), f.delivery, f.commitment)).toEqual({
      status: 'mismatch',
      code: 'block_hash_mismatch',
    });
  });
  it('rejects a different CAR root', async () => {
    const f = await fixture();
    const root = CID.createV1(0x55, await sha256.digest(new Uint8Array([1])));
    expect(
      await verifyCar(await archive(root, [{ cid: root, bytes: new Uint8Array([1]) }]), f.delivery, f.commitment),
    ).toEqual({ status: 'mismatch', code: 'car_root_mismatch' });
  });
  it('checks file SHA separately from the CID', async () => {
    const f = await fixture();
    const d = { ...f.delivery, fileSha256: h };
    expect(await verifyCar(f.car, d, deliveryCommitment(d))).toEqual({
      status: 'mismatch',
      code: 'file_sha256_mismatch',
    });
  });
  it('checks the declared length', async () => {
    const f = await fixture();
    const d = { ...f.delivery, fileSize: f.delivery.fileSize + 1n };
    expect(await verifyCar(f.car, d, deliveryCommitment(d))).toEqual({
      status: 'mismatch',
      code: 'file_size_mismatch',
    });
  });
  it('cannot reuse a commitment from another agreement, deployment, network or metadata', async () => {
    const f = await fixture();
    const changes: Partial<Delivery>[] = [
      { agreementId: 2n },
      { chainId: 31337 },
      { contract: '0x2222222222222222222222222222222222222222' },
      { termsHash: `0x${'22'.repeat(32)}` },
      { fileSize: 20n },
      { mediaType: 2 },
    ];
    for (const change of changes)
      expect(await verifyCar(f.car, { ...f.delivery, ...change }, f.commitment)).toEqual({
        status: 'mismatch',
        code: 'commitment_mismatch',
      });
  });
  it('treats truncated archives and missing blocks as inconclusive', async () => {
    const f = await fixture();
    expect((await verifyCar(f.car.slice(0, 8), f.delivery, f.commitment)).status).toBe('inconclusive');
    expect(await verifyCar(await archive(f.cid, []), f.delivery, f.commitment)).toEqual({
      status: 'inconclusive',
      code: 'missing_block',
    });
  });
  it('bounds archives before parsing and rejects arbitrary HTTP URLs as CIDs', async () => {
    const f = await fixture();
    expect(await verifyCar(new Uint8Array(MAX_CAR_BYTES + 1), f.delivery, f.commitment)).toEqual({
      status: 'inconclusive',
      code: 'car_limit',
    });
    expect((await verifyCar(f.car, { ...f.delivery, cid: 'http://localhost/private' }, f.commitment)).status).toBe(
      'mismatch',
    );
  });
  it('accepts the bounded duplicate-record boundary without changing verified bytes', async () => {
    const f = await fixture();
    const car = await archive(
      f.cid,
      Array.from({ length: 512 }, () => ({ cid: f.cid, bytes: f.bytes })),
    );
    expect(car.byteLength).toBeLessThan(MAX_CAR_BYTES);
    const result = await verifyCar(car, f.delivery, f.commitment);
    expect(result.status).toBe('verified');
    if (result.status === 'verified') expect(result.bytes).toEqual(f.bytes);
  });
  it('limits total CAR records even when every record repeats the same valid CID', async () => {
    const f = await fixture();
    const car = await archive(
      f.cid,
      Array.from({ length: 513 }, () => ({ cid: f.cid, bytes: f.bytes })),
    );
    expect(car.byteLength).toBeLessThan(MAX_CAR_BYTES);
    expect(await verifyCar(car, f.delivery, f.commitment)).toEqual({ status: 'inconclusive', code: 'block_limit' });
  });
  it('checks the bytes of a repeated CID instead of silently skipping duplicates', async () => {
    const f = await fixture();
    const bad = f.bytes.slice();
    bad[0] ^= 1;
    const car = await archive(f.cid, [
      { cid: f.cid, bytes: f.bytes },
      { cid: f.cid, bytes: bad },
    ]);
    expect(await verifyCar(car, f.delivery, f.commitment)).toEqual({ status: 'mismatch', code: 'block_hash_mismatch' });
  });
  it('network failure and HTTP 404 never prove fraud or successful content', async () => {
    const f = await fixture();
    for (const fetcher of [
      async () => {
        throw Error('offline');
      },
      async () => new Response('', { status: 404 }),
    ]) {
      expect(await fetchAndVerify(f.delivery, f.commitment, undefined, fetcher as typeof fetch)).toEqual({
        status: 'inconclusive',
        code: 'gateway_unavailable',
      });
    }
  });
  it('fetches bounded CAR bytes with omitted credentials and redirects rejected', async () => {
    const f = await fixture();
    let called = false;
    const fetcher = (async (url: unknown, init: RequestInit) => {
      called = true;
      expect(String(url)).toContain(`/ipfs/${f.cid}?format=car`);
      expect(init.redirect).toBe('error');
      expect(init.credentials).toBe('omit');
      return new Response(f.car as Uint8Array<ArrayBuffer>, { status: 200 });
    }) as typeof fetch;
    expect((await fetchAndVerify(f.delivery, f.commitment, undefined, fetcher)).status).toBe('verified');
    expect(called).toBe(true);
  });
});

describe('Hedera monetary unit boundary', () => {
  it('uses 18 RPC decimals for test HBAR but 8 inside Hedera Solidity', () => {
    expect(rpcValueForTinybars(296, 100_000_000n)).toBe(1_000_000_000_000_000_000n);
    expect(rpcValueForTinybars(296, 1n)).toBe(10_000_000_000n);
    expect(rpcValueForTinybars(31337, 100_000_000n)).toBe(100_000_000n);
  });
  it('refuses mainnet and amounts outside the demonstration cap', () => {
    expect(() => rpcValueForTinybars(295, 1n)).toThrow('unsupported_chain');
    for (const n of [0n, -1n, 1_000_000_001n]) expect(() => rpcValueForTinybars(296, n)).toThrow('invalid_amount');
  });
});

describe('transaction observation is not a payment claim', () => {
  it('null is inconclusive and may become confirmed on an explicit later query', async () => {
    expect(await inspectTransaction(h, async () => null)).toEqual({ status: 'inconclusive', code: 'not_found' });
    expect(
      await inspectTransaction(h, async () => ({
        transactionHash: h,
        blockHash: h,
        blockNumber: 1n,
        status: 'success',
      })),
    ).toEqual({ status: 'confirmed', blockHash: h, blockNumber: 1n });
  });
  it('incomplete RPC data does not throw, fail a valid receipt or become success', async () => {
    for (const value of [
      undefined,
      {},
      { status: 'success' },
      { transactionHash: h, blockHash: h, blockNumber: '0x1', status: 'success' },
    ])
      expect(await inspectTransaction(h, async () => value)).toEqual({
        status: 'inconclusive',
        code: 'malformed_response',
      });
  });
  it('separates transport failure, wrong transaction and observed reversion', async () => {
    expect(
      await inspectTransaction(h, async () => {
        throw Error();
      }),
    ).toEqual({ status: 'inconclusive', code: 'rpc_unavailable' });
    const r = { transactionHash: h, blockHash: h, blockNumber: 1n, status: 'reverted' };
    expect(await inspectTransaction(h, async () => r)).toEqual({ status: 'failed', code: 'reverted' });
    expect(await inspectTransaction(`0x${'22'.repeat(32)}`, async () => r)).toEqual({
      status: 'failed',
      code: 'wrong_transaction',
    });
  });
});
