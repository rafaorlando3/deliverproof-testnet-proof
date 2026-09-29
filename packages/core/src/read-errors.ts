import { BaseError, ContractFunctionRevertedError } from 'viem';

/** Adapter failures with an explicit, non-successful verifier result. */
export class ChainReadError extends Error {
  constructor(readonly code: 'unknown_agreement' | 'history_query_budget' | 'malformed_history' | 'event_limit') {
    super(code);
    this.name = 'ChainReadError';
  }
}

/** Only a decoded contract revert means an unknown id. Transport errors remain transport errors. */
export function throwAgreementReadError(error: unknown): never {
  if (error instanceof BaseError) {
    const revert = error.walk(e => e instanceof ContractFunctionRevertedError);
    if (revert instanceof ContractFunctionRevertedError && revert.data?.errorName === 'UnknownAgreement') {
      throw new ChainReadError('unknown_agreement');
    }
  }
  throw error;
}
