export declare const ErrorCode: {
    readonly RBAC_FORBIDDEN: "RBAC_FORBIDDEN";
    readonly ENTRY_LOCKED: "ENTRY_LOCKED";
    readonly PERIOD_LOCKED: "PERIOD_LOCKED";
    readonly CHATBOT_DISABLED: "CHATBOT_DISABLED";
    readonly IDEMPOTENCY_CONFLICT: "IDEMPOTENCY_CONFLICT";
    readonly VALIDATION_FAILED: "VALIDATION_FAILED";
    readonly NOT_FOUND: "NOT_FOUND";
    readonly RATE_LIMITED: "RATE_LIMITED";
    readonly LLM_UNAVAILABLE: "LLM_UNAVAILABLE";
    readonly OIDC_FAILURE: "OIDC_FAILURE";
    readonly K_ANONYMITY_THRESHOLD: "K_ANONYMITY_THRESHOLD";
};
export type ErrorCodeValue = (typeof ErrorCode)[keyof typeof ErrorCode];
export declare class DomainError extends Error {
    readonly code: ErrorCodeValue;
    readonly httpStatus: number;
    readonly details?: Record<string, unknown> | unknown[];
    constructor(code: ErrorCodeValue, message: string, httpStatus: number, details?: Record<string, unknown> | unknown[]);
}
export declare class ValidationFailedError extends DomainError {
    constructor(message: string, details?: Record<string, unknown> | unknown[]);
}
export declare class NotFoundError extends DomainError {
    constructor(message?: string, details?: Record<string, unknown>);
}
export declare class EntryLockedError extends DomainError {
    constructor(entryId: number | string, status: string);
}
export declare class PeriodLockedError extends DomainError {
    constructor(isoYear: number, isoWeek: number, status: string);
}
export declare class IdempotencyConflictError extends DomainError {
    constructor(message?: string);
}
export declare class RateLimitedError extends DomainError {
    constructor(message: string, details?: Record<string, unknown>);
}
export declare class LLMUnavailableError extends DomainError {
    constructor(message?: string, details?: Record<string, unknown>);
}
export declare class ChatbotDisabledError extends DomainError {
    constructor(provider: string, model: string);
}
export declare class OIDCFailureError extends DomainError {
    constructor(message?: string);
}
//# sourceMappingURL=index.d.ts.map