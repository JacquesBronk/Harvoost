import { DomainError } from '../errors/index.js';
export declare class KAnonymityError extends DomainError {
    constructor(observed: number, threshold: number);
}
export declare function enforceKAnonymity(groupSize: number, k?: number): number;
//# sourceMappingURL=k-anonymity.d.ts.map