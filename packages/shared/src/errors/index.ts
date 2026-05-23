// Canonical error codes per API_NOTES.md § Error envelope.
// Every domain error in apps/api maps to one of these for the wire envelope.
export const ErrorCode = {
  RBAC_FORBIDDEN: 'RBAC_FORBIDDEN',
  ENTRY_LOCKED: 'ENTRY_LOCKED',
  CHATBOT_DISABLED: 'CHATBOT_DISABLED',
  IDEMPOTENCY_CONFLICT: 'IDEMPOTENCY_CONFLICT',
  VALIDATION_FAILED: 'VALIDATION_FAILED',
  NOT_FOUND: 'NOT_FOUND',
  RATE_LIMITED: 'RATE_LIMITED',
  LLM_UNAVAILABLE: 'LLM_UNAVAILABLE',
  OIDC_FAILURE: 'OIDC_FAILURE',
  K_ANONYMITY_THRESHOLD: 'K_ANONYMITY_THRESHOLD',
} as const;

export type ErrorCodeValue = (typeof ErrorCode)[keyof typeof ErrorCode];

// Base for any domain error that should be mapped to the {code,message,details} envelope.
export class DomainError extends Error {
  public readonly code: ErrorCodeValue;
  public readonly httpStatus: number;
  public readonly details?: Record<string, unknown> | unknown[];

  constructor(
    code: ErrorCodeValue,
    message: string,
    httpStatus: number,
    details?: Record<string, unknown> | unknown[],
  ) {
    super(message);
    this.name = 'DomainError';
    this.code = code;
    this.httpStatus = httpStatus;
    this.details = details;
  }
}

export class ValidationFailedError extends DomainError {
  constructor(message: string, details?: Record<string, unknown> | unknown[]) {
    super(ErrorCode.VALIDATION_FAILED, message, 400, details);
    this.name = 'ValidationFailedError';
  }
}

export class NotFoundError extends DomainError {
  constructor(message = 'Resource not found.', details?: Record<string, unknown>) {
    super(ErrorCode.NOT_FOUND, message, 404, details);
    this.name = 'NotFoundError';
  }
}

export class EntryLockedError extends DomainError {
  constructor(entryId: number | string, status: string) {
    super(
      ErrorCode.ENTRY_LOCKED,
      `Cannot edit entry — currently in status ${status}.`,
      409,
      { entry_id: entryId, status },
    );
    this.name = 'EntryLockedError';
  }
}

export class IdempotencyConflictError extends DomainError {
  constructor(message = 'Idempotency key reused with a different payload.') {
    super(ErrorCode.IDEMPOTENCY_CONFLICT, message, 409);
    this.name = 'IdempotencyConflictError';
  }
}

export class RateLimitedError extends DomainError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(ErrorCode.RATE_LIMITED, message, 429, details);
    this.name = 'RateLimitedError';
  }
}

export class LLMUnavailableError extends DomainError {
  constructor(message = 'LLM provider temporarily unavailable.', details?: Record<string, unknown>) {
    super(ErrorCode.LLM_UNAVAILABLE, message, 503, details);
    this.name = 'LLMUnavailableError';
  }
}

export class ChatbotDisabledError extends DomainError {
  constructor(provider: string, model: string) {
    super(
      ErrorCode.CHATBOT_DISABLED,
      `The chatbot requires an LLM provider with tool-calling support. Current configuration: ${provider}/${model}. Contact your administrator.`,
      503,
      { provider, model },
    );
    this.name = 'ChatbotDisabledError';
  }
}

export class OIDCFailureError extends DomainError {
  constructor(message = 'OIDC authentication failed.') {
    super(ErrorCode.OIDC_FAILURE, message, 401);
    this.name = 'OIDCFailureError';
  }
}
