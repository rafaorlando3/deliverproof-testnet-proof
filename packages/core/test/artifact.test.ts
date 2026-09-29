import { describe, it, expect } from 'vitest';
import { prepareArtifact } from '../src/artifact.js';
import { verifyCar } from '../src/content.js';
import { deliveryCommitment, MAX_FILE_BYTES, type Delivery } from '../src/delivery.js';

describe('browser-local artifact preparation', () => {
  it('round trips exact public bytes through the independent verifier', async () => {
    const bytes = new TextEncoder().encode('Public synthetic delivery. No customer information.\n');
    const artifact = await prepareArtifact(bytes);
    const delivery: Delivery = {
      ...artifact,
      version: 1,
      chainId: 31337,
      contract: '0x1111111111111111111111111111111111111111',
      agreementId: 2n,
      termsHash: `0x${'22'.repeat(32)}`,
      mediaType: 1,
    };
    const verdict = await verifyCar(artifact.car, delivery, deliveryCommitment(delivery));
    expect(verdict.status).toBe('verified');
    if (verdict.status === 'verified') expect(verdict.bytes).toEqual(bytes);
    const changed = artifact.car.slice();
    changed[changed.length - 1] ^= 1;
    expect((await verifyCar(changed, delivery, deliveryCommitment(delivery))).status).toBe('mismatch');
  });
  it('has deterministic CIDs and rejects empty or oversized files', async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    expect((await prepareArtifact(bytes)).cid).toBe((await prepareArtifact(bytes)).cid);
    await expect(prepareArtifact(new Uint8Array())).rejects.toThrow();
    await expect(prepareArtifact(new Uint8Array(MAX_FILE_BYTES + 1))).rejects.toThrow();
  });
});
