"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.KAnonymityError = void 0;
exports.enforceKAnonymity = enforceKAnonymity;
const index_js_1 = require("../errors/index.js");
class KAnonymityError extends index_js_1.DomainError {
    constructor(observed, threshold) {
        super(index_js_1.ErrorCode.K_ANONYMITY_THRESHOLD, `Aggregate has fewer than ${threshold} contributing users; cannot return.`, 400, { observed, threshold });
        this.name = 'KAnonymityError';
    }
}
exports.KAnonymityError = KAnonymityError;
// Throws if `groupSize < k`. Returns the groupSize otherwise for fluent use.
function enforceKAnonymity(groupSize, k = 5) {
    if (!Number.isFinite(groupSize) || groupSize < 0) {
        throw new KAnonymityError(0, k);
    }
    if (groupSize < k) {
        throw new KAnonymityError(groupSize, k);
    }
    return groupSize;
}
//# sourceMappingURL=k-anonymity.js.map