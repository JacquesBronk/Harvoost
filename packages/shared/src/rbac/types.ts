// User and project IDs are bigints at the DB layer; we use string at the application
// boundary so they survive JSON serialization safely (no Number(2^53) clipping).
// Concrete services use whatever the Prisma client produces; the scope service
// normalizes to string internally.
export type UserId = string;
export type ProjectId = string;

export type Role = 'admin' | 'finmgr' | 'manager' | 'employee';

export const ROLES: readonly Role[] = ['admin', 'finmgr', 'manager', 'employee'] as const;

export interface ScopeMeta {
  // Count of distinct projects that contributed to the visibility set via project anchors.
  fromProjects: number;
  // Count of distinct persons (direct reports) that contributed via person anchors.
  fromPersons: number;
}

export interface UserIdScope {
  userIds: UserId[];
  meta: ScopeMeta;
  // True when the requester is admin/finmgr — the userIds list is the full org;
  // callers may skip the IN-filter for performance, but the IDs are still returned
  // so the same code path works for every role.
  unrestricted: boolean;
}

export interface ProjectIdScope {
  projectIds: ProjectId[];
  meta: ScopeMeta;
  unrestricted: boolean;
}
