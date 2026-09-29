import { BaseError, decodeErrorResult, type Hex } from 'viem';
import { deliverProofAbi } from '@deliverproof/core/abi';

const reasons: Record<string, string> = {
  UnknownAgreement: 'This agreement number does not exist on this contract.',
  Unauthorized: 'This wallet is not allowed to take this step for this agreement.',
  WrongState: 'This step is not available in the agreement’s current state. Verify again.',
  DeadlinePassed: 'The deadline for this step has passed.',
  RefundNotAvailable: 'The buyer can refund only after the review deadline.',
  WrongAmount: 'The deposit must be exactly the agreed amount.',
  InvalidTerms: 'The contract refused these terms (supplier, amount or deadlines).',
  InvalidDelivery: 'The contract refused this delivery record (CID, hash, size or media type).',
  WrongCommitment: 'The approval does not match the recorded delivery.',
  AlreadyWithdrawn: 'This credit was already withdrawn.',
  TransferFailed: 'The withdrawal transfer failed. The credit is still available.',
};

/** Contract refusal found by the read-only preflight, in words. Nothing was signed or sent. */
export function explainPreflight(error: unknown): string {
  const raw =
    error instanceof BaseError
      ? (error.walk(
          e =>
            typeof (e as { data?: unknown }).data === 'string' && /^0x[0-9a-f]{8}/i.test((e as { data: string }).data),
        ) as { data?: Hex } | null)
      : null;
  if (raw?.data) {
    try {
      const name = decodeErrorResult({ abi: deliverProofAbi, data: raw.data }).errorName;
      return `${reasons[name] ?? `The contract refused this step (${name}).`} Nothing was sent.`;
    } catch {
      /* not one of this contract's errors */
    }
  }
  return 'The read-only check before signing did not pass, so nothing was sent. Verify the agreement and try again.';
}

/** Only an explicit refusal in the wallet (EIP-1193 code 4001) proves nothing was sent. */
export function isWalletRejection(error: unknown): boolean {
  const code = (e: unknown) => (e as { code?: unknown })?.code === 4001;
  if (code(error)) return true;
  return error instanceof BaseError && !!error.walk(code);
}
