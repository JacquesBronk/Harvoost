import { describe, it, expect, vi } from 'vitest';
import { ZodError } from 'zod';
import {
  ProjectsController,
  CreateProjectTaskSchema,
  UpdateProjectTaskSchema,
} from '../../src/projects/projects.controller';
import { ZodValidationPipe } from '../../src/common/dto/zod-validation.pipe';
import { RolesGuard } from '../../src/auth/roles.guard';
import { ROLES_KEY } from '../../src/common/roles.decorator';
import { Reflector } from '@nestjs/core';
import { NotFoundError, RbacForbiddenError, ValidationFailedError } from '@harvoost/shared';

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

// ---------------------------------------------------------------------------
// FEAT-003 (GitHub #16) — ProjectsController.createProjectTask / updateProjectTask.
// POST /v1/projects/{project_id}/tasks → 201 ProjectTask (Admin/FinMgr).
// PATCH /v1/projects/{project_id}/tasks/{task_id} → 200 ProjectTask (Admin/FinMgr).
// Reuses the listTasks visibility/existence 404 gate; maps the partial-unique
// 23505 (duplicate ACTIVE name) to a clean ValidationFailedError(TASK_NAME_EXISTS);
// empty PATCH body → 400 (ZodError via the schema refine); no DELETE.
// ---------------------------------------------------------------------------

const finmgr = { userId: '2', email: 'f@x', roles: ['finmgr'] };

// Mirrors makePrismaStub but adds write-path handlers: INSERT INTO project_tasks,
// the single-task ownership SELECT (id + project_id), and the UPDATE ... RETURNING.
// `taskExists` controls the ownership SELECT; `insertedRow`/`updatedRow` are the
// RETURNING payloads; `conflict` makes the next INSERT/UPDATE throw Postgres 23505.
function makeWritePrismaStub(opts: {
  projectExists?: boolean;
  taskExists?: boolean;
  insertedRow?: Record<string, unknown>;
  updatedRow?: Record<string, unknown>;
  conflict?: boolean;
} = {}) {
  const calls: Array<{ sql: string; values: unknown[] }> = [];
  const stub = {
    calls,
    $queryRawUnsafe: vi.fn(async (sql: string, ...values: unknown[]) => {
      calls.push({ sql, values });
      if (sql.includes('FROM projects')) {
        return (opts.projectExists ?? true) ? [{ id: values[0] }] : [];
      }
      if (sql.startsWith('SELECT id FROM project_tasks')) {
        return (opts.taskExists ?? true) ? [{ id: values[0] }] : [];
      }
      if (sql.includes('INSERT INTO project_tasks')) {
        if (opts.conflict) {
          throw Object.assign(new Error('duplicate key value violates unique constraint "project_tasks_active_name_unique"'), { code: '23505' });
        }
        return [opts.insertedRow ?? { id: 99, project_id: values[0], name: values[1], is_billable: values[2], is_active: true }];
      }
      if (sql.includes('UPDATE project_tasks')) {
        if (opts.conflict) {
          throw Object.assign(new Error('duplicate key value violates unique constraint "project_tasks_active_name_unique"'), { code: '23505' });
        }
        return [opts.updatedRow ?? { id: 7, project_id: 5, name: 'updated', is_billable: true, is_active: true }];
      }
      return [];
    }),
  };
  return stub;
}

describe('ProjectsController.createProjectTask — AC-1 happy path', () => {
  it('returns a ProjectTask with string ids + coerced booleans and audits project.task_create', async () => {
    const prisma = makeWritePrismaStub({
      insertedRow: { id: 42, project_id: 5, name: 'Development', is_billable: true, is_active: true },
    });
    const audit = makeAuditStub();
    const ctrl = new ProjectsController(prisma as never, makeRbacStub({ unrestricted: true }) as never, audit as never);

    const out = await ctrl.createProjectTask(admin, '5', { name: 'Development', is_billable: true });

    expect(out).toEqual({ id: '42', project_id: '5', name: 'Development', is_billable: true, is_active: true });
    expect(typeof out.id).toBe('string');
    expect(typeof out.project_id).toBe('string');
    const insert = prisma.calls.find((c) => c.sql.includes('INSERT INTO project_tasks'))!;
    expect(insert.values).toEqual(['5', 'Development', true]);
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'project.task_create', entityType: 'project_task', entityId: '42', actorId: '1' }),
    );
  });

  it('honours is_billable: false', async () => {
    const prisma = makeWritePrismaStub({
      insertedRow: { id: 43, project_id: 5, name: 'Research', is_billable: false, is_active: true },
    });
    const ctrl = new ProjectsController(prisma as never, makeRbacStub({ unrestricted: true }) as never, makeAuditStub() as never);
    const out = await ctrl.createProjectTask(admin, '5', { name: 'Research', is_billable: false });
    expect(out.is_billable).toBe(false);
  });

  it('allows a finmgr to create a task (AC-5 role allow)', async () => {
    const prisma = makeWritePrismaStub({
      insertedRow: { id: 44, project_id: 5, name: 'QA', is_billable: true, is_active: true },
    });
    const ctrl = new ProjectsController(prisma as never, makeRbacStub({ unrestricted: true }) as never, makeAuditStub() as never);
    const out = await ctrl.createProjectTask(finmgr, '5', { name: 'QA', is_billable: true });
    expect(out.id).toBe('44');
  });
});

describe('ProjectsController.createProjectTask — AC-5 unknown project 404', () => {
  it('404s for a missing project even for an unrestricted admin (never inserts)', async () => {
    const prisma = makeWritePrismaStub({ projectExists: false });
    const ctrl = new ProjectsController(prisma as never, makeRbacStub({ unrestricted: true }) as never, makeAuditStub() as never);
    await expect(ctrl.createProjectTask(admin, '999', { name: 'X', is_billable: true })).rejects.toBeInstanceOf(NotFoundError);
    expect(prisma.calls.some((c) => c.sql.includes('INSERT INTO project_tasks'))).toBe(false);
  });

  it('404s a scoped requester who cannot see the project (no existence leak, never inserts)', async () => {
    const prisma = makeWritePrismaStub({ projectExists: true });
    const ctrl = new ProjectsController(prisma as never, makeRbacStub({ unrestricted: false, projectIds: ['1', '2'] }) as never, makeAuditStub() as never);
    await expect(ctrl.createProjectTask(finmgr, '5', { name: 'X', is_billable: true })).rejects.toBeInstanceOf(NotFoundError);
    expect(prisma.calls.some((c) => c.sql.includes('INSERT INTO project_tasks'))).toBe(false);
  });
});

describe('ProjectsController.createProjectTask — AC-6 duplicate active name', () => {
  it('maps Postgres 23505 to ValidationFailedError(TASK_NAME_EXISTS), not a raw 500', async () => {
    const prisma = makeWritePrismaStub({ conflict: true });
    const ctrl = new ProjectsController(prisma as never, makeRbacStub({ unrestricted: true }) as never, makeAuditStub() as never);
    await expect(ctrl.createProjectTask(admin, '5', { name: 'Development', is_billable: true })).rejects.toMatchObject({
      name: 'ValidationFailedError',
      details: { code: 'TASK_NAME_EXISTS' },
    });
  });

  it('does not audit when the insert conflicts', async () => {
    const prisma = makeWritePrismaStub({ conflict: true });
    const audit = makeAuditStub();
    const ctrl = new ProjectsController(prisma as never, makeRbacStub({ unrestricted: true }) as never, audit as never);
    await expect(ctrl.createProjectTask(admin, '5', { name: 'Development', is_billable: true })).rejects.toBeInstanceOf(ValidationFailedError);
    expect(audit.record).not.toHaveBeenCalled();
  });
});

describe('ProjectsController.updateProjectTask — AC-2 rename + billability', () => {
  it('updates only the provided field (name) and audits project.task_update', async () => {
    const prisma = makeWritePrismaStub({
      updatedRow: { id: 7, project_id: 5, name: 'Dev (renamed)', is_billable: true, is_active: true },
    });
    const audit = makeAuditStub();
    const ctrl = new ProjectsController(prisma as never, makeRbacStub({ unrestricted: true }) as never, audit as never);

    const out = await ctrl.updateProjectTask(admin, '5', '7', { name: 'Dev (renamed)' });

    expect(out).toEqual({ id: '7', project_id: '5', name: 'Dev (renamed)', is_billable: true, is_active: true });
    const upd = prisma.calls.find((c) => c.sql.includes('UPDATE project_tasks'))!;
    expect(upd.sql).toContain('name = $1');
    expect(upd.sql).toContain('updated_at = NOW()');
    expect(upd.sql).not.toContain('is_billable = ');
    expect(upd.sql).not.toContain('is_active = ');
    // params: [name, taskId, projectId]
    expect(upd.values).toEqual(['Dev (renamed)', '7', '5']);
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'project.task_update', entityType: 'project_task', entityId: '7' }),
    );
  });

  it('updates is_billable without touching name', async () => {
    const prisma = makeWritePrismaStub({
      updatedRow: { id: 7, project_id: 5, name: 'Development', is_billable: false, is_active: true },
    });
    const ctrl = new ProjectsController(prisma as never, makeRbacStub({ unrestricted: true }) as never, makeAuditStub() as never);
    const out = await ctrl.updateProjectTask(admin, '5', '7', { is_billable: false });
    expect(out.is_billable).toBe(false);
    expect(out.name).toBe('Development');
    const upd = prisma.calls.find((c) => c.sql.includes('UPDATE project_tasks'))!;
    expect(upd.sql).not.toContain('name = ');
    expect(upd.sql).toContain('is_billable = $1::boolean');
  });
});

describe('ProjectsController.updateProjectTask — AC-3 archive', () => {
  it('PATCH is_active=false returns is_active:false and audits project.task_archive', async () => {
    const prisma = makeWritePrismaStub({
      updatedRow: { id: 7, project_id: 5, name: 'Development', is_billable: true, is_active: false },
    });
    const audit = makeAuditStub();
    const ctrl = new ProjectsController(prisma as never, makeRbacStub({ unrestricted: true }) as never, audit as never);
    const out = await ctrl.updateProjectTask(admin, '5', '7', { is_active: false });
    expect(out.is_active).toBe(false);
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'project.task_archive', entityType: 'project_task', entityId: '7' }),
    );
  });

  it('reactivation (is_active=true) audits project.task_update', async () => {
    const prisma = makeWritePrismaStub({
      updatedRow: { id: 7, project_id: 5, name: 'Development', is_billable: true, is_active: true },
    });
    const audit = makeAuditStub();
    const ctrl = new ProjectsController(prisma as never, makeRbacStub({ unrestricted: true }) as never, audit as never);
    const out = await ctrl.updateProjectTask(admin, '5', '7', { is_active: true });
    expect(out.is_active).toBe(true);
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ action: 'project.task_update' }));
  });
});

describe('ProjectsController.updateProjectTask — AC-5 404 cases', () => {
  it('404s when the project is missing (never queries the task)', async () => {
    const prisma = makeWritePrismaStub({ projectExists: false });
    const ctrl = new ProjectsController(prisma as never, makeRbacStub({ unrestricted: true }) as never, makeAuditStub() as never);
    await expect(ctrl.updateProjectTask(admin, '999', '7', { name: 'x' })).rejects.toBeInstanceOf(NotFoundError);
    expect(prisma.calls.some((c) => c.sql.startsWith('SELECT id FROM project_tasks'))).toBe(false);
  });

  it('404s when the task does not exist / belongs to another project (never updates)', async () => {
    const prisma = makeWritePrismaStub({ projectExists: true, taskExists: false });
    const ctrl = new ProjectsController(prisma as never, makeRbacStub({ unrestricted: true }) as never, makeAuditStub() as never);
    await expect(ctrl.updateProjectTask(admin, '5', '7', { name: 'x' })).rejects.toBeInstanceOf(NotFoundError);
    expect(prisma.calls.some((c) => c.sql.includes('UPDATE project_tasks'))).toBe(false);
  });

  it('404s a scoped requester who cannot see the project (no existence leak)', async () => {
    const prisma = makeWritePrismaStub({ projectExists: true });
    const ctrl = new ProjectsController(prisma as never, makeRbacStub({ unrestricted: false, projectIds: ['1'] }) as never, makeAuditStub() as never);
    await expect(ctrl.updateProjectTask(employee, '5', '7', { name: 'x' })).rejects.toBeInstanceOf(NotFoundError);
  });

  it('scopes the task ownership SELECT to (task_id, project_id)', async () => {
    const prisma = makeWritePrismaStub({ projectExists: true, taskExists: true });
    const ctrl = new ProjectsController(prisma as never, makeRbacStub({ unrestricted: true }) as never, makeAuditStub() as never);
    await ctrl.updateProjectTask(admin, '5', '7', { name: 'x' });
    const sel = prisma.calls.find((c) => c.sql.startsWith('SELECT id FROM project_tasks'))!;
    expect(sel.sql).toContain('id = $1::bigint AND project_id = $2::bigint');
    expect(sel.values).toEqual(['7', '5']);
  });
});

describe('ProjectsController.updateProjectTask — AC-6 duplicate active name on rename/reactivate', () => {
  it('maps 23505 to ValidationFailedError(TASK_NAME_EXISTS)', async () => {
    const prisma = makeWritePrismaStub({ projectExists: true, taskExists: true, conflict: true });
    const ctrl = new ProjectsController(prisma as never, makeRbacStub({ unrestricted: true }) as never, makeAuditStub() as never);
    await expect(ctrl.updateProjectTask(admin, '5', '7', { name: 'Development' })).rejects.toMatchObject({
      name: 'ValidationFailedError',
      details: { code: 'TASK_NAME_EXISTS' },
    });
  });
});

// AC-4 — body validation. The write routes validate via @Body(new
// ZodValidationPipe(schema)), so the schemas are exercised through the pipe (the
// HttpExceptionFilter maps the thrown ZodError to 400). A ZodError is the
// 400-producing failure here.
describe('CreateProjectTaskSchema — AC-4 create validation', () => {
  const pipe = new ZodValidationPipe(CreateProjectTaskSchema);
  const meta = {} as never;

  it('rejects an empty name (minLength 1) with a ZodError', () => {
    expect(() => pipe.transform({ name: '' }, meta)).toThrow(ZodError);
  });

  it('rejects a missing name with a ZodError', () => {
    expect(() => pipe.transform({ is_billable: true }, meta)).toThrow(ZodError);
  });

  it('defaults is_billable to true when omitted', () => {
    expect(pipe.transform({ name: 'Development' }, meta)).toEqual({ name: 'Development', is_billable: true });
  });

  it('rejects unknown fields (strict)', () => {
    expect(() => pipe.transform({ name: 'X', evil: 1 }, meta)).toThrow(ZodError);
  });
});

describe('UpdateProjectTaskSchema — AC-4 empty PATCH → 400', () => {
  const pipe = new ZodValidationPipe(UpdateProjectTaskSchema);
  const meta = {} as never;

  it('rejects an empty body {} with a ZodError (minProperties: 1 honoured)', () => {
    expect(() => pipe.transform({}, meta)).toThrow(ZodError);
  });

  it('accepts a single provided field', () => {
    expect(pipe.transform({ is_active: false }, meta)).toEqual({ is_active: false });
  });

  it('rejects an empty name when name is the only key', () => {
    expect(() => pipe.transform({ name: '' }, meta)).toThrow(ZodError);
  });

  it('rejects unknown fields (strict)', () => {
    expect(() => pipe.transform({ evil: 1 }, meta)).toThrow(ZodError);
  });
});

// AC-5 — RBAC role guard on the two write routes. The @Roles('admin','finmgr')
// metadata is what the live RolesGuard reads to allow admin/finmgr and 403
// everyone else; the in-controller body methods never run for a disallowed role.
// Mirrors the projects-members-managers.test.ts precedent: drive the REAL
// RolesGuard against the REAL decorator metadata via a synthetic ExecutionContext,
// rather than re-implementing the role check.
function runGuard(handler: (...args: unknown[]) => unknown, user: { roles: string[] } | undefined) {
  const guard = new RolesGuard(new Reflector());
  const ctx = {
    getHandler: () => handler,
    getClass: () => ProjectsController,
    switchToHttp: () => ({ getRequest: () => ({ user }) }),
  } as never;
  return guard.canActivate(ctx);
}

describe('ProjectsController task write routes — AC-5 @Roles(admin,finmgr) guard', () => {
  it('createProjectTask + updateProjectTask both carry @Roles(admin, finmgr) metadata', () => {
    for (const name of ['createProjectTask', 'updateProjectTask'] as const) {
      const roles = Reflect.getMetadata(ROLES_KEY, ProjectsController.prototype[name]);
      expect(roles).toEqual(['admin', 'finmgr']);
    }
  });

  it('RolesGuard allows an admin on createProjectTask and updateProjectTask', () => {
    expect(runGuard(ProjectsController.prototype.createProjectTask, { roles: ['admin'] })).toBe(true);
    expect(runGuard(ProjectsController.prototype.updateProjectTask, { roles: ['admin'] })).toBe(true);
  });

  it('RolesGuard allows a finmgr on createProjectTask and updateProjectTask', () => {
    expect(runGuard(ProjectsController.prototype.createProjectTask, { roles: ['finmgr'] })).toBe(true);
    expect(runGuard(ProjectsController.prototype.updateProjectTask, { roles: ['finmgr'] })).toBe(true);
  });

  it('RolesGuard 403s an employee on createProjectTask (no row created)', () => {
    expect(() => runGuard(ProjectsController.prototype.createProjectTask, { roles: ['employee'] })).toThrow(
      RbacForbiddenError,
    );
  });

  it('RolesGuard 403s a manager on createProjectTask and updateProjectTask', () => {
    expect(() => runGuard(ProjectsController.prototype.createProjectTask, { roles: ['manager'] })).toThrow(
      RbacForbiddenError,
    );
    expect(() => runGuard(ProjectsController.prototype.updateProjectTask, { roles: ['manager'] })).toThrow(
      RbacForbiddenError,
    );
  });

  it('RolesGuard rejects an unauthenticated request (no user) on the write routes', () => {
    expect(() => runGuard(ProjectsController.prototype.createProjectTask, undefined)).toThrow(
      RbacForbiddenError,
    );
    expect(() => runGuard(ProjectsController.prototype.updateProjectTask, undefined)).toThrow(
      RbacForbiddenError,
    );
  });
});
