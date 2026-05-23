/**
 * RBAC_TEST_FIXTURE — the canonical Alice / Bob / Carol / Dave topology used
 * across the codebase for cascade-visibility tests.
 *
 * Sourced from REQUIREMENTS.md § "Cascade visibility worked example" and
 * ARCHITECTURE.md § Data model. Used by:
 *   - prisma/seed.ts (writes these into the dev DB)
 *   - apps/api integration tests (asserts RbacScopeService output)
 *   - chatbot tool integration tests (asserts tool RBAC filter)
 *
 * Expected visibility (manager → reports):
 *   - Alice (manager + project-manager of P1) sees:
 *       * Bob   via user_managers (person anchor) — sees Bob on ALL his projects
 *       * Carol via project_managers(P1) ∩ project_members(P1)
 *     Alice does NOT see Dave (Dave is not on P1 nor anchored to Alice).
 *     Alice does NOT see Bob's P2 hours.
 *   - Bob, Carol, Dave see only themselves.
 *   - Erin (manager + project-manager of P4) sees Carol via P4.
 *   - Frank (manager) sees no one (no anchors).
 *   - Admin / FinMgr see everyone.
 */

export interface RbacFixtureUser {
  /** key used to look up the user from the fixture map */
  key: string;
  email: string;
  displayName: string;
  /** Roles to assign in user_roles. May be multiple. */
  roles: ReadonlyArray<'admin' | 'finmgr' | 'manager' | 'employee'>;
  /** IANA timezone */
  timezone: string;
}

export interface RbacFixtureProject {
  /** key used to look up the project from the fixture map */
  key: string;
  code: string;
  name: string;
  billingMode: 'hourly' | 'fixed_fee' | 'non_billable';
  currency: string;
  fixedFeeAmount?: number;
  hoursBudget?: number;
  /** Member user-keys (project_members) */
  memberKeys: ReadonlyArray<string>;
  /** Project-manager user-keys (project_managers) */
  managerKeys: ReadonlyArray<string>;
}

export interface RbacTestFixture {
  client: { key: string; name: string };
  users: ReadonlyArray<RbacFixtureUser>;
  projects: ReadonlyArray<RbacFixtureProject>;
  /** person-anchor: { managerKey -> [reportKeys] } */
  personAnchors: Readonly<Record<string, ReadonlyArray<string>>>;
  /** Default per-user cost rate (test currency). Used for financial fixtures. */
  costRatesByUserKey: Readonly<Record<string, number>>;
  /** Default per-project billable rate. */
  billableRatesByProjectKey: Readonly<Record<string, number>>;
  currency: string;
}

export const RBAC_TEST_FIXTURE: RbacTestFixture = {
  client: { key: 'demoCo', name: 'Demo Client Ltd' },
  users: [
    // Admin
    {
      key: 'admin',
      email: process.env.BOOTSTRAP_ADMIN_EMAIL ?? 'admin@harvoost.local',
      displayName: 'Admin User',
      roles: ['admin'],
      timezone: 'Africa/Johannesburg',
    },
    // Financial Manager
    {
      key: 'finmgr',
      email: 'finmgr@harvoost.local',
      displayName: 'Fiona Finmgr',
      roles: ['finmgr'],
      timezone: 'Africa/Johannesburg',
    },
    // Managers
    {
      key: 'alice',
      email: 'alice@harvoost.local',
      displayName: 'Alice Manager',
      roles: ['manager'],
      timezone: 'Africa/Johannesburg',
    },
    {
      key: 'erin',
      email: 'erin@harvoost.local',
      displayName: 'Erin Manager',
      roles: ['manager'],
      timezone: 'Europe/Amsterdam',
    },
    {
      key: 'frank',
      email: 'frank@harvoost.local',
      displayName: 'Frank Manager',
      roles: ['manager'],
      timezone: 'Africa/Johannesburg',
    },
    // Employees
    {
      key: 'bob',
      email: 'bob@harvoost.local',
      displayName: 'Bob Employee',
      roles: ['employee'],
      timezone: 'Africa/Johannesburg',
    },
    {
      key: 'carol',
      email: 'carol@harvoost.local',
      displayName: 'Carol Employee',
      roles: ['employee'],
      timezone: 'Africa/Johannesburg',
    },
    {
      key: 'dave',
      email: 'dave@harvoost.local',
      displayName: 'Dave Employee',
      roles: ['employee'],
      timezone: 'Africa/Johannesburg',
    },
    {
      key: 'grace',
      email: 'grace@harvoost.local',
      displayName: 'Grace Employee',
      roles: ['employee'],
      timezone: 'Europe/London',
    },
  ],
  projects: [
    {
      key: 'P1',
      code: 'P1',
      name: 'Atlas (hourly)',
      billingMode: 'hourly',
      currency: 'ZAR',
      hoursBudget: 400,
      memberKeys: ['bob', 'carol'],
      managerKeys: ['alice'],
    },
    {
      key: 'P2',
      code: 'P2',
      name: 'Orion (hourly)',
      billingMode: 'hourly',
      currency: 'ZAR',
      hoursBudget: 320,
      memberKeys: ['bob', 'dave'],
      managerKeys: [], // unmanaged — only Admin / FinMgr / personal anchors see it
    },
    {
      key: 'P3',
      code: 'P3',
      name: 'Pegasus (fixed-fee)',
      billingMode: 'fixed_fee',
      currency: 'ZAR',
      fixedFeeAmount: 250000,
      memberKeys: ['dave'],
      managerKeys: [],
    },
    {
      key: 'P4',
      code: 'P4',
      name: 'Internal Ops (non-billable)',
      billingMode: 'non_billable',
      currency: 'ZAR',
      memberKeys: ['carol', 'grace'],
      managerKeys: ['erin'],
    },
  ],
  personAnchors: {
    alice: ['bob'],
    // frank deliberately has no reports — used to test "manager with no anchors"
  },
  costRatesByUserKey: {
    bob: 350.0,
    carol: 380.0,
    dave: 410.0,
    grace: 420.0,
    // Managers/admins also have cost rates for accuracy in cross-charge reports.
    alice: 600.0,
    erin: 590.0,
    frank: 580.0,
    finmgr: 700.0,
    admin: 800.0,
  },
  billableRatesByProjectKey: {
    P1: 1100.0,
    P2: 1200.0,
    P3: 0.0, // fixed-fee — billable rate unused, kept for consistency
    P4: 0.0, // non-billable
  },
  currency: 'ZAR',
};
