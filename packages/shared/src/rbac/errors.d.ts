import { DomainError } from '../errors/index.js';
export declare class RbacError extends Error {
    constructor(message: string);
}
export declare class RbacForbiddenError extends DomainError {
    constructor(message?: string, details?: Record<string, unknown>);
}
//# sourceMappingURL=errors.d.ts.map