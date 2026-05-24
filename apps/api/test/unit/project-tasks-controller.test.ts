import { describe, it, expect, vi } from 'vitest';
import { ProjectsController } from '../../src/projects/projects.controller';
import { NotFoundError, ValidationFailedError } from '@harvoost/shared';

// FEAT-001 (GitHub #5) — ProjectsController.listTasks.
// GET /v1/projects/{project_id}/tasks → { data: ProjectTask[] }, read-only,
// project-visibility scoped (admin/finmgr unrestricted, others scoped). A
// project the requester cannot see (or that does not exist) returns 404 — never
// 403 — so existence never leaks. bigint ids (id, project_id) are String()-mapped.
// Optional is_active (boolean) narrows on project_tasks.is_active when present.

function makePrismaStub(opts: { projectExists?: boolean; taskRows?: Array<Record<string, unknown>> } = {}) {
  const calls: Array<{ sql: string; values: unknown[] }> = [];
  return {
    calls,
    $queryRawUnsafe: vi.fn(async (sql: string, ...values: unknown[]) => {
      calls.push({ sql, values });
      if (sql.includes('FROM projects')) {
        return (opts.projectExists ?? true) ? [{ id: values[0] }] : [];
      }
      if (sql.includes('FROM project_tasks')) {
        return opts.taskRows ?? [];
      }
      return [];
    }),
  };
}

function makeRbacStub(scope: { unrestricted: boolean; projectIds?: string[] }) {
  return {
    getVisibleProjectIds: vi.fn(async () => ({
      projectIds: scope.projectIds ?? [],
      meta: { fromProjects: 0, fromPersons: 0 },
      unrestricted: scope.unrestricted,
    })),
    assertCanSeeProject: vi.fn(async () => undefined),
  };
}

function makeAuditStub() {
  return { record: vi.fn(async () => undefined) };
}

const admin = { userId: '1', email: 'a@x', roles: ['admin'] };
const employee = { userId: '20', email: 'e@x', roles: ['employee'] };

const TASK_ROWS = [
  { id: 7, project_id: 5, name: 'General', is_billable: true, is_active: true },
  { id: 8, project_id: 5, name: 'Research', is_billable: false, is_active: false },
];

describe('ProjectsController.listTasks — 200 shape', () => {
  it('returns { data: ProjectTask[] } with string ids and boolean fields', async () => {
    const prisma = makePrismaStub({ projectExists: true, taskRows: TASK_ROWS });
    const ctrl = new ProjectsController(
      prisma as never,
      makeRbacStub({ unrestricted: true }) as never,
      makeAuditStub() as never,
    );
    const out = await ctrl.listTasks(admin, '5', undefined);
    expect(out.data).toHaveLength(2);
    expect(out.data[0]).toEqual({
      id: '7',
      project_id: '5',
      name: 'General',
      is_billable: true,
      is_active: true,
    });
    // Every id is a string, never a number/bigint, on the wire.
    expect(typeof out.data[0]!.id).toBe('string');
    expect(typeof out.data[0]!.project_id).toBe('string');
    expect(typeof out.data[1]!.is_billable).toBe('boolean');
    expect(typeof out.data[1]!.is_active).toBe('boolean');
  });

  it('returns { data: [] } for a visible project with no tasks', async () => {
    const prisma = makePrismaStub({ projectExists: true, taskRows: [] });
    const ctrl = new ProjectsController(
      prisma as never,
      makeRbacStub({ unrestricted: true }) as never,
      makeAuditStub() as never,
    );
    const out = await ctrl.listTasks(admin, '5', undefined);
    expect(out).toEqual({ data: [] });
  });

  it('orders results by name then id for stable output', async () => {
    const prisma = makePrismaStub({ projectExists: true, taskRows: TASK_ROWS });
    const ctrl = new ProjectsController(
      prisma as never,
      makeRbacStub({ unrestricted: true }) as never,
      makeAuditStub() as never,
    );
    await ctrl.listTasks(admin, '5', undefined);
    const taskSql = prisma.calls.map((c) => c.sql).find((s) => s.includes('FROM project_tasks'));
    expect(taskSql).toContain('ORDER BY name ASC, id ASC');
  });
});

describe('ProjectsController.listTasks — is_active filter', () => {
  it('is_active=true narrows the query with a bound boolean param', async () => {
    const prisma = makePrismaStub({ projectExists: true, taskRows: [TASK_ROWS[0]!] });
    const ctrl = new ProjectsController(
      prisma as never,
      makeRbacStub({ unrestricted: true }) as never,
      makeAuditStub() as never,
    );
    const out = await ctrl.listTasks(admin, '5', 'true');
    const taskCall = prisma.calls.find((c) => c.sql.includes('FROM project_tasks'))!;
    expect(taskCall.sql).toContain('is_active = $2::boolean');
    expect(taskCall.values).toEqual(['5', true]);
    expect(out.data).toHaveLength(1);
  });

  it('is_active=false narrows the query with a bound false param', async () => {
    const prisma = makePrismaStub({ projectExists: true, taskRows: [TASK_ROWS[1]!] });
    const ctrl = new ProjectsController(
      prisma as never,
      makeRbacStub({ unrestricted: true }) as never,
      makeAuditStub() as never,
    );
    const out = await ctrl.listTasks(admin, '5', 'false');
    const taskCall = prisma.calls.find((c) => c.sql.includes('FROM project_tasks'))!;
    expect(taskCall.values).toEqual(['5', false]);
    expect(out.data[0]!.is_active).toBe(false);
  });

  it('absent is_active applies no filter (all tasks)', async () => {
    const prisma = makePrismaStub({ projectExists: true, taskRows: TASK_ROWS });
    const ctrl = new ProjectsController(
      prisma as never,
      makeRbacStub({ unrestricted: true }) as never,
      makeAuditStub() as never,
    );
    await ctrl.listTasks(admin, '5', undefined);
    const taskCall = prisma.calls.find((c) => c.sql.includes('FROM project_tasks'))!;
    expect(taskCall.sql).not.toContain('is_active =');
    expect(taskCall.values).toEqual(['5']);
  });

  it('rejects a non-boolean is_active with ValidationFailedError', async () => {
    const prisma = makePrismaStub({ projectExists: true });
    const ctrl = new ProjectsController(
      prisma as never,
      makeRbacStub({ unrestricted: true }) as never,
      makeAuditStub() as never,
    );
    await expect(ctrl.listTasks(admin, '5', 'yes')).rejects.toBeInstanceOf(ValidationFailedError);
  });
});

describe('ProjectsController.listTasks — RBAC (no existence leak)', () => {
  it('404s a scoped requester who cannot see the project (never queries tasks)', async () => {
    const prisma = makePrismaStub({ projectExists: true, taskRows: TASK_ROWS });
    const ctrl = new ProjectsController(
      prisma as never,
      makeRbacStub({ unrestricted: false, projectIds: ['1', '2'] }) as never,
      makeAuditStub() as never,
    );
    await expect(ctrl.listTasks(employee, '5', undefined)).rejects.toBeInstanceOf(NotFoundError);
    // The visibility gate short-circuits before any task SELECT runs.
    expect(prisma.calls.some((c) => c.sql.includes('FROM project_tasks'))).toBe(false);
  });

  it('allows a scoped requester to list tasks for a project they can see', async () => {
    const prisma = makePrismaStub({ projectExists: true, taskRows: [TASK_ROWS[0]!] });
    const ctrl = new ProjectsController(
      prisma as never,
      makeRbacStub({ unrestricted: false, projectIds: ['5'] }) as never,
      makeAuditStub() as never,
    );
    const out = await ctrl.listTasks(employee, '5', undefined);
    expect(out.data).toHaveLength(1);
    expect(out.data[0]!.project_id).toBe('5');
  });

  it('404s when the project does not exist, even for an unrestricted admin', async () => {
    const prisma = makePrismaStub({ projectExists: false });
    const ctrl = new ProjectsController(
      prisma as never,
      makeRbacStub({ unrestricted: true }) as never,
      makeAuditStub() as never,
    );
    await expect(ctrl.listTasks(admin, '999', undefined)).rejects.toBeInstanceOf(NotFoundError);
  });
});
