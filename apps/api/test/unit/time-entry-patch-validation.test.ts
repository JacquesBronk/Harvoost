import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ZodError } from 'zod';
import { TimeEntriesController } from '../../src/time-entries/time-entries.controller';
import { RbacForbiddenError, NotFoundError } from '@harvoost/shared';

// Tests Finding 5 — PATCH /v1/time-entries/:id body validation + cross-project IDOR guard.

function makePrismaStub(opts: { existing?: Record<string, unknown> | null } = {}) {
  const executed: Array<{ sql: string; values: unknown[] }> = [];
  return {
    executed,
    $queryRawUnsafe: vi.fn(async (sql: string) => {
      if (sql.includes('FROM time_entries') && sql.includes('SELECT status, user_id')) {
        if (opts.existing === null) return [];
        return [
          {
            status: 'draft',
            user_id: '10',
            project_id: '100',
            task_id: null,
            notes: null,
            start_at: '2026-05-01T08:00:00Z',
            end_at: '2026-05-01T09:00:00Z',
            billable: true,
            ...opts.existing,
          },
        ];
      }
      return [];
    }),
    $executeRawUnsafe: vi.fn(async (sql: string, ...values: unknown[]) => {
      executed.push({ sql, values });
      return 1;
    }),
  };
}

function makeRbacStub(allowed: boolean) {
  return {
    assertCanSeeProject: vi.fn(async () => {
      if (!allowed) throw new RbacForbiddenError();
    }),
    assertCanSeeUser: vi.fn(),
    getVisibleUserIds: vi.fn(async () => ({ userIds: ['10'], unrestricted: false, meta: { fromProjects: 0, fromPersons: 0 } })),
    getVisibleProjectIds: vi.fn(async () => ({ projectIds: ['100'], unrestricted: false, meta: { fromProjects: 0, fromPersons: 0 } })),
  };
}

function makeIdemStub() {
  return { lookup: vi.fn(), store: vi.fn() };
}

function makeAuditStub() {
  return { record: vi.fn(async () => undefined) };
}

function makeSyncStub() {
  return { emit: vi.fn(), subscribe: vi.fn(), subscriberCount: vi.fn(() => 0) };
}

const actor = { userId: '10', email: 'e@e', roles: ['employee'] };

describe('TimeEntriesController.edit — strict schema + RBAC', () => {
  it('rejects unknown fields with a ZodError', async () => {
    const prisma = makePrismaStub();
    const rbac = makeRbacStub(true);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ctrl = new TimeEntriesController(prisma as any, makeIdemStub() as any, rbac as any, makeAuditStub() as any, makeSyncStub() as any);
    await expect(ctrl.edit(actor, '1', { malicious_field: 'evil' })).rejects.toBeInstanceOf(ZodError);
  });

  it('rejects malformed project_id (non-numeric string)', async () => {
    const prisma = makePrismaStub();
    const rbac = makeRbacStub(true);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ctrl = new TimeEntriesController(prisma as any, makeIdemStub() as any, rbac as any, makeAuditStub() as any, makeSyncStub() as any);
    await expect(ctrl.edit(actor, '1', { project_id: '../../etc/passwd' })).rejects.toBeInstanceOf(ZodError);
  });

  it('IDOR guard: rejects a project_id change that the requester cannot see', async () => {
    const prisma = makePrismaStub();
    const rbac = makeRbacStub(false);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ctrl = new TimeEntriesController(prisma as any, makeIdemStub() as any, rbac as any, makeAuditStub() as any, makeSyncStub() as any);
    // body.project_id (200) differs from existing (100) → RBAC check fires.
    await expect(ctrl.edit(actor, '1', { project_id: '200' })).rejects.toBeInstanceOf(RbacForbiddenError);
    expect(rbac.assertCanSeeProject).toHaveBeenCalledWith(actor.userId, '200');
  });

  it('happy path: notes-only edit issues UPDATE + audit row, no RBAC project check', async () => {
    const prisma = makePrismaStub();
    const rbac = makeRbacStub(true);
    const audit = makeAuditStub();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ctrl = new TimeEntriesController(prisma as any, makeIdemStub() as any, rbac as any, audit as any, makeSyncStub() as any);
    const out = await ctrl.edit(actor, '1', { notes: 'updated note' });
    expect(out).toEqual({ ok: true });
    expect(rbac.assertCanSeeProject).not.toHaveBeenCalled();
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'time_entry.edit', entityType: 'time_entry', entityId: '1' }),
    );
    expect(prisma.executed[0].sql).toMatch(/UPDATE time_entries/);
  });

  it('returns NotFound when the entry is owned by someone else (uniform 404)', async () => {
    const prisma = makePrismaStub({ existing: { user_id: '99' } });
    const rbac = makeRbacStub(true);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ctrl = new TimeEntriesController(prisma as any, makeIdemStub() as any, rbac as any, makeAuditStub() as any, makeSyncStub() as any);
    await expect(ctrl.edit(actor, '1', { notes: 'x' })).rejects.toBeInstanceOf(NotFoundError);
  });
});
