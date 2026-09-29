import { CID } from 'multiformats/cid';
import { encodeAbiParameters, keccak256, stringToHex, type Address, type Hex } from 'viem';

export const MAX_FILE_BYTES = 1_048_576;
export const MAX_CAR_BYTES = 4_194_304;
export const DOMAIN = keccak256(stringToHex('DeliverProof.delivery.v1'));
export type Delivery = {
  chainId: 296 | 31337;
  contract: Address;
  agreementId: bigint;
  termsHash: Hex;
  cid: string;
  fileSha256: Hex;
  fileSize: bigint;
  mediaType: 1 | 2 | 3;
  version: 1;
};
const nonzeroHash = (s: unknown): s is Hex =>
  typeof s === 'string' && /^0x[0-9a-fA-F]{64}$/.test(s) && !/^0x0{64}$/.test(s);

export function validateDelivery(d: Delivery): void {
  if (d.chainId !== 296 && d.chainId !== 31337) throw new Error('unsupported_chain');
  if (!/^0x[0-9a-fA-F]{40}$/.test(d.contract) || /^0x0{40}$/.test(d.contract)) throw new Error('invalid_contract');
  if (typeof d.agreementId !== 'bigint' || d.agreementId < 1n || d.agreementId >= 2n ** 256n)
    throw new Error('invalid_agreement');
  if (!nonzeroHash(d.termsHash) || !nonzeroHash(d.fileSha256)) throw new Error('invalid_hash');
  if (typeof d.fileSize !== 'bigint' || d.fileSize < 1n || d.fileSize > BigInt(MAX_FILE_BYTES))
    throw new Error('invalid_size');
  if (![1, 2, 3].includes(d.mediaType) || d.version !== 1) throw new Error('invalid_metadata');
  const cid = CID.parse(d.cid);
  if (
    cid.version !== 1 ||
    cid.toString() !== d.cid ||
    d.cid.length > 96 ||
    ![0x55, 0x70].includes(cid.code) ||
    cid.multihash.code !== 0x12 ||
    cid.multihash.size !== 32
  ) {
    throw new Error('unsupported_cid');
  }
}

export function deliveryCommitment(d: Delivery): Hex {
  validateDelivery(d);
  return keccak256(
    encodeAbiParameters(
      [
        { type: 'bytes32' },
        { type: 'uint256' },
        { type: 'address' },
        { type: 'uint256' },
        { type: 'bytes32' },
        { type: 'bytes32' },
        { type: 'bytes32' },
        { type: 'uint64' },
        { type: 'uint8' },
        { type: 'uint32' },
      ],
      [
        DOMAIN,
        BigInt(d.chainId),
        d.contract,
        d.agreementId,
        d.termsHash,
        keccak256(stringToHex(d.cid)),
        d.fileSha256,
        d.fileSize,
        d.mediaType,
        d.version,
      ],
    ),
  );
}

/** JSON-RPC tx.value is 18 decimals on Hedera; Solidity msg.value is tinybars (8).
 * On a plain local EVM we use raw units matching the Solidity test amount. */
export function rpcValueForTinybars(chainId: number, tinybars: bigint): bigint {
  if (tinybars <= 0n || tinybars > 1_000_000_000n) throw new Error('invalid_amount');
  if (chainId === 296) return tinybars * 10_000_000_000n;
  if (chainId === 31337) return tinybars;
  throw new Error('unsupported_chain');
}
