import { describe, it, expect, beforeEach } from 'vitest';
import { RbacScopeService } from '../RbacScopeService';
import { RbacError } from '../errors';
import type { RbacPrismaLike } from '../RbacScopeService';

// In-memory fixture mirroring the REQUIREMENTS.md worked example:
//   - Alice (manager): project-anchored to P1 (always); person-anchor toggled in tests.
//   - Bob: member of P1 and P2.
//   - Carol: member of P1.
//   - Dave: member of P2.
//
// We expose a tiny stub that satisfies RbacPrismaLike and answers the same UNIONs
// the real RbacScopeService SQL expects.
interface Fixture {
  users: { id: string; is_active: boolean }[];
  projects: { id: string; is_active: boolean }[];
  projectMembers: { project_id: string; user_id: string; left_at: string | null }[];
  projectManagers: { project_id: string; manager_id: string }[];
  userManagers: { user_id: string; manager_id: string }[];
  userRoles: { user_id: string; role: string }[];
}

function makePrisma(fx: Fixture): RbacPrismaLike {
  return {
    userRole: {
      findMany: async ({ where }) => {
        const uid = String(where.userId);
        return fx.userRoles.filter((r) => r.user_id === uid).map((r) => ({ role: r.role }));
      },
    },
    $queryRawUnsafe: async <T = unknown>(sql: string, ...values: unknown[]): Promise<T> => {
      // The service issues a small set of fixed queries — we dispatch on substrings.
      if (sql.includes('FROM users WHERE is_active')) {
        return fx.users.filter((u) => u.is_active).map((u) => ({ user_id: u.id })) as T;
      }
      if (sql.includes('FROM projects WHERE is_active')) {
        return fx.projects.filter((p) => p.is_active).map((p) => ({ project_id: p.id })) as T;
      }
      const requesterId = String(values[0]);
      if (sql.includes('project_anchored AS') && sql.includes('SELECT DISTINCT pm.user_id')) {
        // getVisibleUserIds path.
        const projectAnchoredProjects = fx.projectManagers
          .filter((pm) => pm.manager_id === requesterId)
          .map((pm) => pm.project_id);
        const projectAnchored = new Map<string, string>(); // user_id -> via_project
        for (const m of fx.projectMembers) {
          if (m.left_at !== null) continue;
          if (projectAnchoredProjects.includes(m.project_id)) {
            projectAnchored.set(m.user_id, m.project_id);
          }
        }
        const personAnchored = fx.userManagers
          .filter((um) => um.manager_id === requesterId)
          .map((um) => um.user_id);
        const allUserIds = new Set<string>([...projectAnchored.keys(), ...personAnchored, requesterId]);
        const fromProjects = new Set(projectAnchored.values()).size;
        const fromPersons = personAnchored.length;
        return Array.from(allUserIds).map((uid) => ({
          user_id: uid,
          from_projects: fromProjects,
          from_persons: fromPersons,
        })) as T;
      }
      if (sql.includes('project_anchored AS') && sql.includes('SELECT pgm.project_id')) {
        // getVisibleProjectIds path.
        const projectAnchored = fx.projectManagers
          .filter((pm) => pm.manager_id === requesterId)
          .map((pm) => pm.project_id);
        const directReports = fx.userManagers
          .filter((um) => um.manager_id === requesterId)
          .map((um) => um.user_id);
        const personAnchored = new Map<string, string>(); // project_id -> via_user
        for (const m of fx.projectMembers) {
          if (m.left_at !== null) continue;
          if (directReports.includes(m.user_id)) {
            personAnchored.set(m.project_id, m.user_id);
          }
        }
        // FEAT-002 (issue #6): self_anchored — the requester's OWN active member-projects.
        const selfAnchored = fx.projectMembers
          .filter((m) => m.left_at === null && m.user_id === requesterId)
          .map((m) => m.project_id);
        const allProjectIds = new Set<string>([
          ...projectAnchored,
          ...personAnchored.keys(),
          ...selfAnchored,
        ]);
        // meta stays manager-anchored (self-membership is NOT counted here).
        const fromProjects = projectAnchored.length;
        const fromPersons = new Set(personAnchored.values()).size;
        return Array.from(allProjectIds).map((pid) => ({
          project_id: pid,
          from_projects: fromProjects,
          from_persons: fromPersons,
        })) as T;
      }
      throw new Error(`unexpected SQL in test stub: ${sql.slice(0, 80)}`);
    },
  };
}

const ALICE = '101';
const BOB = '102';
const CAROL = '103';
const DAVE = '104';
const ADMIN = '999';
const P1 = '1';
const P2 = '2';

function baseFixture(): Fixture {
  return {
    users: [
      { id: ALICE, is_active: true },
      { id: BOB, is_active: true },
      { id: CAROL, is_active: true },
      { id: DAVE, is_active: true },
      { id: ADMIN, is_active: true },
    ],
    projects: [
      { id: P1, is_active: true },
      { id: P2, is_active: true },
    ],
    projectMembers: [
      { project_id: P1, user_id: BOB, left_at: null },
      { project_id: P1, user_id: CAROL, left_at: null },
      { project_id: P2, user_id: BOB, left_at: null },
      { project_id: P2, user_id: DAVE, left_at: null },
    ],
    projectManagers: [{ project_id: P1, manager_id: ALICE }],
    userManagers: [],
    userRoles: [
      { user_id: ALICE, role: 'manager' },
      { user_id: BOB, role: 'employee' },
      { user_id: CAROL, role: 'employee' },
      { user_id: DAVE, role: 'employee' },
      { user_id: ADMIN, role: 'admin' },
    ],
  };
}

describe('RbacScopeService — Alice/Bob/Carol/Dave worked example', () => {
  let fx: Fixture;
  let svc: RbacScopeService;

  beforeEach(() => {
    fx = baseFixture();
    svc = new RbacScopeService({ prisma: makePrisma(fx) });
  });

  it('Alice (project-anchored to P1 only) sees Bob, Carol, and herself', async () => {
    const scope = await svc.getVisibleUserIds(ALICE);
    expect(new Set(scope.userIds)).toEqual(new Set([ALICE, BOB, CAROL]));
    expect(scope.userIds).not.toContain(DAVE);
    expect(scope.unrestricted).toBe(false);
  });

  it('Alice (project-anchored to P1 only) sees only P1, not P2', async () => {
    const scope = await svc.getVisibleProjectIds(ALICE);
    expect(scope.projectIds).toEqual([P1]);
    expect(scope.projectIds).not.toContain(P2);
  });

  it('Alice also person-anchored to Bob now sees P2 too', async () => {
    fx.userManagers.push({ user_id: BOB, manager_id: ALICE });
    const scope = await svc.getVisibleProjectIds(ALICE);
    expect(new Set(scope.projectIds)).toEqual(new Set([P1, P2]));
  });

  it('Alice person-anchored to Bob still does NOT see Dave (cascade does not transit)', async () => {
    fx.userManagers.push({ user_id: BOB, manager_id: ALICE });
    const scope = await svc.getVisibleUserIds(ALICE);
    // Bob and Carol via P1, Bob via person anchor (already in set), self. Dave never appears.
    expect(scope.userIds).not.toContain(DAVE);
    expect(new Set(scope.userIds)).toEqual(new Set([ALICE, BOB, CAROL]));
  });

  it('admin sees everyone (unrestricted=true)', async () => {
    const scope = await svc.getVisibleUserIds(ADMIN);
    expect(scope.unrestricted).toBe(true);
    expect(new Set(scope.userIds)).toEqual(new Set([ALICE, BOB, CAROL, DAVE, ADMIN]));
  });

  it('admin sees every project (unrestricted=true)', async () => {
    const scope = await svc.getVisibleProjectIds(ADMIN);
    expect(scope.unrestricted).toBe(true);
    expect(new Set(scope.projectIds)).toEqual(new Set([P1, P2]));
  });

  it('canActAsRole returns true only when the user holds that role', async () => {
    expect(await svc.canActAsRole(ADMIN, 'admin')).toBe(true);
    expect(await svc.canActAsRole(ALICE, 'admin')).toBe(false);
    expect(await svc.canActAsRole(ALICE, 'manager')).toBe(true);
  });

  it('withSelfScope returns only the requester id', () => {
    expect(svc.withSelfScope(BOB)).toEqual({ userIds: [BOB], selfOnly: true });
  });

  it('assertCanSeeUser allows visible target, throws on hidden', async () => {
    await expect(svc.assertCanSeeUser(ALICE, BOB)).resolves.toBeUndefined();
    await expect(svc.assertCanSeeUser(ALICE, DAVE)).rejects.toThrow();
  });

  it('throws RbacError on empty requesterId', async () => {
    await expect(svc.getVisibleUserIds('')).rejects.toBeInstanceOf(RbacError);
  });

  it('meta reports anchor breakdown', async () => {
    fx.userManagers.push({ user_id: BOB, manager_id: ALICE });
    const scope = await svc.getVisibleUserIds(ALICE);
    // fromProjects counts distinct anchor-projects (P1). fromPersons counts direct reports (Bob).
    expect(scope.meta.fromProjects).toBeGreaterThanOrEqual(1);
    expect(scope.meta.fromPersons).toBe(1);
  });
});

describe('RbacScopeService — FEAT-002 employee self-visibility (issue #6)', () => {
  let fx: Fixture;
  let svc: RbacScopeService;

  beforeEach(() => {
    fx = baseFixture();
    svc = new RbacScopeService({ prisma: makePrisma(fx) });
  });

  it('a plain employee (Bob) sees the projects they are a MEMBER of (P1 + P2)', async () => {
    // Bob manages nothing; pre-FEAT-002 this returned []. Now it unions Bob's member-projects.
    const scope = await svc.getVisibleProjectIds(BOB);
    expect(new Set(scope.projectIds)).toEqual(new Set([P1, P2]));
    expect(scope.unrestricted).toBe(false);
  });

  it('a plain employee (Carol) does NOT see a non-member project (P2)', async () => {
    // Carol is a member of P1 only — P2 must stay invisible to her.
    const scope = await svc.getVisibleProjectIds(CAROL);
    expect(scope.projectIds).toEqual([P1]);
    expect(scope.projectIds).not.toContain(P2);
  });

  it('a plain employee with NO memberships sees no projects (not a leak)', async () => {
    // A lone user (the admin id, treated here as a non-admin role for this fixture) with no
    // memberships and no management still resolves to an empty project set — no widening.
    fx.userRoles = fx.userRoles.map((r) => (r.user_id === ADMIN ? { ...r, role: 'employee' } : r));
    const scope = await svc.getVisibleProjectIds(ADMIN);
    expect(scope.projectIds).toEqual([]);
  });

  it('a manager (Alice) project visibility is UNCHANGED — still her managed project only', async () => {
    // Alice manages P1, is a member of nothing → still exactly [P1], no regression.
    const scope = await svc.getVisibleProjectIds(ALICE);
    expect(scope.projectIds).toEqual([P1]);
  });

  it('a manager who is ALSO a member of another project sees both (manager + self union)', async () => {
    // Alice manages P1 AND is added as a member of P2 → both via the self-anchor union.
    fx.projectMembers.push({ project_id: P2, user_id: ALICE, left_at: null });
    const scope = await svc.getVisibleProjectIds(ALICE);
    expect(new Set(scope.projectIds)).toEqual(new Set([P1, P2]));
  });

  it('a LEFT (soft-removed) membership does NOT grant project visibility', async () => {
    // Bob left P2 (left_at set) → only P1 remains visible.
    fx.projectMembers = fx.projectMembers.map((m) =>
      m.project_id === P2 && m.user_id === BOB ? { ...m, left_at: '2026-01-01' } : m,
    );
    const scope = await svc.getVisibleProjectIds(BOB);
    expect(scope.projectIds).toEqual([P1]);
  });

  it('employee user-visibility still includes self (own entries stay visible)', async () => {
    // getVisibleUserIds already unions {self}; confirm Bob is in his own visible-user set.
    const scope = await svc.getVisibleUserIds(BOB);
    expect(scope.userIds).toContain(BOB);
    // Bob manages no one and anchors no project, so he sees ONLY himself — no other users.
    expect(scope.userIds).toEqual([BOB]);
  });

  it('employee project-membership does NOT leak other members of that project', async () => {
    // Bob is a member of P1 (with Carol) and P2 (with Dave). His VISIBLE USERS must remain
    // {Bob} only — membership grants PROJECT visibility, not other-user visibility.
    const userScope = await svc.getVisibleUserIds(BOB);
    expect(userScope.userIds).toEqual([BOB]);
    expect(userScope.userIds).not.toContain(CAROL);
    expect(userScope.userIds).not.toContain(DAVE);
  });
});

describe('enforceKAnonymity', () => {
  it('passes when groupSize >= k', async () => {
    const { enforceKAnonymity } = await import('../k-anonymity.js');
    expect(enforceKAnonymity(5)).toBe(5);
    expect(enforceKAnonymity(10, 5)).toBe(10);
  });
  it('throws when groupSize < k', async () => {
    const { enforceKAnonymity, KAnonymityError } = await import('../k-anonymity.js');
    expect(() => enforceKAnonymity(4)).toThrow(KAnonymityError);
    expect(() => enforceKAnonymity(0)).toThrow(KAnonymityError);
  });
});
