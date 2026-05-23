import { DomainError, ErrorCode } from '../errors/index';

export class KAnonymityError extends DomainError {
  constructor(observed: number, threshold: number) {
    super(
      ErrorCode.K_ANONYMITY_THRESHOLD,
      `Aggregate has fewer than ${threshold} contributing users; cannot return.`,
      400,
      { observed, threshold },
    );
    this.name = 'KAnonymityError';
  }
}

// Throws if `groupSize < k`. Returns the groupSize otherwise for fluent use.
export function enforceKAnonymity(groupSize: number, k = 5): number {
  if (!Number.isFinite(groupSize) || groupSize < 0) {
    throw new KAnonymityError(0, k);
  }
  if (groupSize < k) {
    throw new KAnonymityError(groupSize, k);
  }
  return groupSize;
}
