/**
 * RBAC fixture mirror for e2e tests.
 *
 * Mirrors packages/db/src/fixtures.ts so that the e2e suite can run as a
 * standalone @playwright/test project without pulling the monorepo build
 * graph. Keep this file in lockstep with the canonical fixture.
 *
 * Identifiers (user.id, project.id) are deterministic numeric strings so
 * route-mock handlers can return them without coordinating with Postgres.
 */

export type Role = 'admin' | 'finmgr' | 'manager' | 'employee';

export interface FixtureUser {
  id: string;
  key: 'admin' | 'finmgr' | 'alice' | 'erin' | 'frank' | 'bob' | 'carol' | 'dave' | 'grace';
  email: string;
  displayName: string;
  roles: Role[];
  timezone: string;
}

export interface FixtureProject {
  id: string;
  key: 'P1' | 'P2' | 'P3' | 'P4';
  code: string;
  name: string;
  billingMode: 'hourly' | 'fixed_fee' | 'non_billable';
  memberIds: string[];
  managerIds: string[];
}

export const USERS: Record<FixtureUser['key'], FixtureUser> = {
  admin: {
    id: '1',
    key: 'admin',
    email: 'admin@harvoost.local',
    displayName: 'Admin User',
    roles: ['admin'],
    timezone: 'Africa/Johannesburg',
  },
  finmgr: {
    id: '2',
    key: 'finmgr',
    email: 'finmgr@harvoost.local',
    displayName: 'Fiona Finmgr',
    roles: ['finmgr'],
    timezone: 'Africa/Johannesburg',
  },
  alice: {
    id: '3',
    key: 'alice',
    email: 'alice@harvoost.local',
    displayName: 'Alice Manager',
    roles: ['manager'],
    timezone: 'Africa/Johannesburg',
  },
  erin: {
    id: '4',
    key: 'erin',
    email: 'erin@harvoost.local',
    displayName: 'Erin Manager',
    roles: ['manager'],
    timezone: 'Europe/Amsterdam',
  },
  frank: {
    id: '5',
    key: 'frank',
    email: 'frank@harvoost.local',
    displayName: 'Frank Manager',
    roles: ['manager'],
    timezone: 'Africa/Johannesburg',
  },
  bob: {
    id: '6',
    key: 'bob',
    email: 'bob@harvoost.local',
    displayName: 'Bob Employee',
    roles: ['employee'],
    timezone: 'Africa/Johannesburg',
  },
  carol: {
    id: '7',
    key: 'carol',
    email: 'carol@harvoost.local',
    displayName: 'Carol Employee',
    roles: ['employee'],
    timezone: 'Africa/Johannesburg',
  },
  dave: {
    id: '8',
    key: 'dave',
    email: 'dave@harvoost.local',
    displayName: 'Dave Employee',
    roles: ['employee'],
    timezone: 'Africa/Johannesburg',
  },
  grace: {
    id: '9',
    key: 'grace',
    email: 'grace@harvoost.local',
    displayName: 'Grace Employee',
    roles: ['employee'],
    timezone: 'Europe/London',
  },
};

export const PROJECTS: Record<FixtureProject['key'], FixtureProject> = {
  P1: {
    id: '101',
    key: 'P1',
    code: 'P1',
    name: 'Atlas (hourly)',
    billingMode: 'hourly',
    memberIds: [USERS.bob.id, USERS.carol.id],
    managerIds: [USERS.alice.id],
  },
  P2: {
    id: '102',
    key: 'P2',
    code: 'P2',
    name: 'Orion (hourly)',
    billingMode: 'hourly',
    memberIds: [USERS.bob.id, USERS.dave.id],
    managerIds: [],
  },
  P3: {
    id: '103',
    key: 'P3',
    code: 'P3',
    name: 'Pegasus (fixed-fee)',
    billingMode: 'fixed_fee',
    memberIds: [USERS.dave.id],
    managerIds: [],
  },
  P4: {
    id: '104',
    key: 'P4',
    code: 'P4',
    name: 'Internal Ops (non-billable)',
    billingMode: 'non_billable',
    memberIds: [USERS.carol.id, USERS.grace.id],
    managerIds: [USERS.erin.id],
  },
};

// Person-anchor (user_managers): managerKey -> [reportKeys]
export const PERSON_ANCHORS: Partial<Record<FixtureUser['key'], FixtureUser['key'][]>> = {
  alice: ['bob'],
};

/**
 * Compute the visibility scope for a given manager per REQUIREMENTS.md §
 * cascading manager visibility. Admin and FinMgr have unrestricted scope.
 */
export function visibleUserIds(actorKey: FixtureUser['key']): Set<string> {
  const actor = USERS[actorKey];
  if (actor.roles.includes('admin') || actor.roles.includes('finmgr')) {
    return new Set(Object.values(USERS).map((u) => u.id));
  }
  if (actor.roles.includes('employee') && !actor.roles.includes('manager')) {
    return new Set([actor.id]);
  }
  // Manager: union of (members of projects they manage) + (anchored people)
  const out = new Set<string>([actor.id]);
  for (const p of Object.values(PROJECTS)) {
    if (p.managerIds.includes(actor.id)) {
      for (const mid of p.memberIds) out.add(mid);
    }
  }
  for (const reportKey of PERSON_ANCHORS[actorKey] ?? []) {
    out.add(USERS[reportKey].id);
  }
  return out;
}

export function visibleProjectIds(actorKey: FixtureUser['key']): Set<string> {
  const actor = USERS[actorKey];
  if (actor.roles.includes('admin') || actor.roles.includes('finmgr')) {
    return new Set(Object.values(PROJECTS).map((p) => p.id));
  }
  if (actor.roles.includes('employee') && !actor.roles.includes('manager')) {
    const out = new Set<string>();
    for (const p of Object.values(PROJECTS)) {
      if (p.memberIds.includes(actor.id)) out.add(p.id);
    }
    return out;
  }
  const out = new Set<string>();
  for (const p of Object.values(PROJECTS)) {
    if (p.managerIds.includes(actor.id)) out.add(p.id);
  }
  // Person-anchored: add every project the anchored reports are on.
  for (const reportKey of PERSON_ANCHORS[actorKey] ?? []) {
    const r = USERS[reportKey];
    for (const p of Object.values(PROJECTS)) {
      if (p.memberIds.includes(r.id)) out.add(p.id);
    }
  }
  return out;
}
