export type UserId = string;
export type ProjectId = string;
export type Role = 'admin' | 'finmgr' | 'manager' | 'employee';
export declare const ROLES: readonly Role[];
export interface ScopeMeta {
    fromProjects: number;
    fromPersons: number;
}
export interface UserIdScope {
    userIds: UserId[];
    meta: ScopeMeta;
    unrestricted: boolean;
}
export interface ProjectIdScope {
    projectIds: ProjectId[];
    meta: ScopeMeta;
    unrestricted: boolean;
}
//# sourceMappingURL=types.d.ts.map