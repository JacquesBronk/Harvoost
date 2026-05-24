"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.OIDCFailureError = exports.ChatbotDisabledError = exports.LLMUnavailableError = exports.RateLimitedError = exports.IdempotencyConflictError = exports.PeriodLockedError = exports.EntryLockedError = exports.NotFoundError = exports.ValidationFailedError = exports.DomainError = exports.ErrorCode = void 0;
// Canonical error codes per API_NOTES.md § Error envelope.
// Every domain error in apps/api maps to one of these for the wire envelope.
exports.ErrorCode = {
    RBAC_FORBIDDEN: 'RBAC_FORBIDDEN',
    ENTRY_LOCKED: 'ENTRY_LOCKED',
    PERIOD_LOCKED: 'PERIOD_LOCKED',
    CHATBOT_DISABLED: 'CHATBOT_DISABLED',
    IDEMPOTENCY_CONFLICT: 'IDEMPOTENCY_CONFLICT',
    VALIDATION_FAILED: 'VALIDATION_FAILED',
    NOT_FOUND: 'NOT_FOUND',
    RATE_LIMITED: 'RATE_LIMITED',
    LLM_UNAVAILABLE: 'LLM_UNAVAILABLE',
    OIDC_FAILURE: 'OIDC_FAILURE',
    K_ANONYMITY_THRESHOLD: 'K_ANONYMITY_THRESHOLD',
};
// Base for any domain error that should be mapped to the {code,message,details} envelope.
class DomainError extends Error {
    constructor(code, message, httpStatus, details) {
        super(message);
        this.name = 'DomainError';
        this.code = code;
        this.httpStatus = httpStatus;
        this.details = details;
    }
}
exports.DomainError = DomainError;
class ValidationFailedError extends DomainError {
    constructor(message, details) {
        super(exports.ErrorCode.VALIDATION_FAILED, message, 400, details);
        this.name = 'ValidationFailedError';
    }
}
exports.ValidationFailedError = ValidationFailedError;
class NotFoundError extends DomainError {
    constructor(message = 'Resource not found.', details) {
        super(exports.ErrorCode.NOT_FOUND, message, 404, details);
        this.name = 'NotFoundError';
    }
}
exports.NotFoundError = NotFoundError;
class EntryLockedError extends DomainError {
    constructor(entryId, status) {
        super(exports.ErrorCode.ENTRY_LOCKED, `Cannot edit entry — currently in status ${status}.`, 409, { entry_id: entryId, status });
        this.name = 'EntryLockedError';
    }
}
exports.EntryLockedError = EntryLockedError;
// FEAT-002 (issue #6): a write whose start_at lands in an ISO-week with a
// timesheet_periods row in a LOCKED status (submitted/manager_approved/final_approved).
// Mirrors EntryLockedError exactly; the global HttpExceptionFilter maps it to
// {code,message,details}. The DB lock trigger (SQLSTATE HV001) is the TOCTOU backstop;
// the app-level assertPeriodWritable precheck throws this directly for a clean envelope.
class PeriodLockedError extends DomainError {
    constructor(isoYear, isoWeek, status) {
        super(exports.ErrorCode.PERIOD_LOCKED, `Cannot write into week ${isoYear}-W${String(isoWeek).padStart(2, '0')} — it is ${status} and locked.`, 409, { iso_year: isoYear, iso_week: isoWeek, status });
        this.name = 'PeriodLockedError';
    }
}
exports.PeriodLockedError = PeriodLockedError;
class IdempotencyConflictError extends DomainError {
    constructor(message = 'Idempotency key reused with a different payload.') {
        super(exports.ErrorCode.IDEMPOTENCY_CONFLICT, message, 409);
        this.name = 'IdempotencyConflictError';
    }
}
exports.IdempotencyConflictError = IdempotencyConflictError;
class RateLimitedError extends DomainError {
    constructor(message, details) {
        super(exports.ErrorCode.RATE_LIMITED, message, 429, details);
        this.name = 'RateLimitedError';
    }
}
exports.RateLimitedError = RateLimitedError;
class LLMUnavailableError extends DomainError {
    constructor(message = 'LLM provider temporarily unavailable.', details) {
        super(exports.ErrorCode.LLM_UNAVAILABLE, message, 503, details);
        this.name = 'LLMUnavailableError';
    }
}
exports.LLMUnavailableError = LLMUnavailableError;
class ChatbotDisabledError extends DomainError {
    constructor(provider, model) {
        super(exports.ErrorCode.CHATBOT_DISABLED, `The chatbot requires an LLM provider with tool-calling support. Current configuration: ${provider}/${model}. Contact your administrator.`, 503, { provider, model });
        this.name = 'ChatbotDisabledError';
    }
}
exports.ChatbotDisabledError = ChatbotDisabledError;
class OIDCFailureError extends DomainError {
    constructor(message = 'OIDC authentication failed.') {
        super(exports.ErrorCode.OIDC_FAILURE, message, 401);
        this.name = 'OIDCFailureError';
    }
}
exports.OIDCFailureError = OIDCFailureError;
//# sourceMappingURL=index.js.map