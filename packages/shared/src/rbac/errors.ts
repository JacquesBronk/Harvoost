import { DomainError, ErrorCode } from '../errors/index';

// Generic RBAC error — for invalid input to the scope service (e.g., null requesterId).
export class RbacError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RbacError';
  }
}

// 403-mapped: requester is authenticated but not allowed.
export class RbacForbiddenError extends DomainError {
  constructor(message = 'Not authorized to perform this action.', details?: Record<string, unknown>) {
    super(ErrorCode.RBAC_FORBIDDEN, message, 403, details);
    this.name = 'RbacForbiddenError';
  }
}
