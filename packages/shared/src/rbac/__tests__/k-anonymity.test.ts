import { describe, it, expect } from 'vitest';
import { enforceKAnonymity, KAnonymityError } from '../k-anonymity';
import { ErrorCode } from '../../errors/index';

describe('enforceKAnonymity (REQUIREMENTS § Security § Mood data)', () => {
  it('passes when group size equals the threshold (k=5 default)', () => {
    expect(enforceKAnonymity(5)).toBe(5);
  });

  it('passes when group size exceeds the threshold', () => {
    expect(enforceKAnonymity(50)).toBe(50);
  });

  it('throws K_ANONYMITY_THRESHOLD error when group size is 4 (just below default)', () => {
    expect(() => enforceKAnonymity(4)).toThrow(KAnonymityError);
  });

  it('throws when group size is 0', () => {
    expect(() => enforceKAnonymity(0)).toThrow(KAnonymityError);
  });

  it('throws on negative group sizes (defensive — never trust caller)', () => {
    expect(() => enforceKAnonymity(-1)).toThrow(KAnonymityError);
  });

  it('throws on NaN / non-finite input', () => {
    expect(() => enforceKAnonymity(Number.NaN)).toThrow(KAnonymityError);
    expect(() => enforceKAnonymity(Number.POSITIVE_INFINITY)).toThrow(KAnonymityError);
  });

  it('respects a custom threshold (e.g., k=10 for tighter privacy)', () => {
    expect(() => enforceKAnonymity(9, 10)).toThrow(KAnonymityError);
    expect(enforceKAnonymity(10, 10)).toBe(10);
  });

  it('emits the K_ANONYMITY_THRESHOLD error code and HTTP 400', () => {
    try {
      enforceKAnonymity(2);
      throw new Error('did not throw');
    } catch (err) {
      expect(err).toBeInstanceOf(KAnonymityError);
      const e = err as KAnonymityError;
      expect(e.code).toBe(ErrorCode.K_ANONYMITY_THRESHOLD);
      expect(e.httpStatus).toBe(400);
      expect(e.details).toMatchObject({ observed: 2, threshold: 5 });
    }
  });
});
