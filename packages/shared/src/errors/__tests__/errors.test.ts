import { describe, it, expect } from 'vitest';
import {
  ErrorCode,
  DomainError,
  ValidationFailedError,
  NotFoundError,
  EntryLockedError,
  IdempotencyConflictError,
  RateLimitedError,
  LLMUnavailableError,
  ChatbotDisabledError,
  OIDCFailureError,
} from '../index';

describe('Canonical error taxonomy (API_NOTES § Error envelope)', () => {
  it('exposes the 10 documented error codes', () => {
    const codes = Object.values(ErrorCode);
    expect(codes).toContain('RBAC_FORBIDDEN');
    expect(codes).toContain('ENTRY_LOCKED');
    expect(codes).toContain('CHATBOT_DISABLED');
    expect(codes).toContain('IDEMPOTENCY_CONFLICT');
    expect(codes).toContain('VALIDATION_FAILED');
    expect(codes).toContain('NOT_FOUND');
    expect(codes).toContain('RATE_LIMITED');
    expect(codes).toContain('LLM_UNAVAILABLE');
    expect(codes).toContain('OIDC_FAILURE');
    expect(codes).toContain('K_ANONYMITY_THRESHOLD');
    expect(codes).toHaveLength(10);
  });

  it.each([
    ['ValidationFailedError', new ValidationFailedError('bad input'), 'VALIDATION_FAILED', 400],
    ['NotFoundError', new NotFoundError(), 'NOT_FOUND', 404],
    ['EntryLockedError', new EntryLockedError(1, 'final_approved'), 'ENTRY_LOCKED', 409],
    ['IdempotencyConflictError', new IdempotencyConflictError(), 'IDEMPOTENCY_CONFLICT', 409],
    ['RateLimitedError', new RateLimitedError('too many'), 'RATE_LIMITED', 429],
    ['LLMUnavailableError', new LLMUnavailableError(), 'LLM_UNAVAILABLE', 503],
    ['ChatbotDisabledError', new ChatbotDisabledError('openai', 'gpt-4o'), 'CHATBOT_DISABLED', 503],
    ['OIDCFailureError', new OIDCFailureError(), 'OIDC_FAILURE', 401],
  ])('%s maps to code=%s, httpStatus=%i', (_name, err, code, status) => {
    expect(err).toBeInstanceOf(DomainError);
    expect((err as DomainError).code).toBe(code);
    expect((err as DomainError).httpStatus).toBe(status);
  });

  it('ChatbotDisabledError surfaces provider/model in details (for client UI)', () => {
    const e = new ChatbotDisabledError('ollama', 'phi3');
    expect(e.details).toMatchObject({ provider: 'ollama', model: 'phi3' });
    // Message must be human-readable and include the offending config.
    expect(e.message).toMatch(/ollama/);
    expect(e.message).toMatch(/phi3/);
  });

  it('EntryLockedError carries entry_id + status in details', () => {
    const e = new EntryLockedError(42, 'final_approved');
    expect(e.details).toMatchObject({ entry_id: 42, status: 'final_approved' });
  });
});
