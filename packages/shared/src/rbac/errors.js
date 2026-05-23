"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.RbacForbiddenError = exports.RbacError = void 0;
const index_js_1 = require("../errors/index.js");
// Generic RBAC error — for invalid input to the scope service (e.g., null requesterId).
class RbacError extends Error {
    constructor(message) {
        super(message);
        this.name = 'RbacError';
    }
}
exports.RbacError = RbacError;
// 403-mapped: requester is authenticated but not allowed.
class RbacForbiddenError extends index_js_1.DomainError {
    constructor(message = 'Not authorized to perform this action.', details) {
        super(index_js_1.ErrorCode.RBAC_FORBIDDEN, message, 403, details);
        this.name = 'RbacForbiddenError';
    }
}
exports.RbacForbiddenError = RbacForbiddenError;
//# sourceMappingURL=errors.js.map