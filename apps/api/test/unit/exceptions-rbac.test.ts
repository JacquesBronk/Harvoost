import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ExceptionsController } from '../../src/exceptions/exceptions.controller';
import { NotFoundError, RbacForbiddenError } from '@harvoost/shared';

// Tests Finding 2 (Exception resolve — self-resolve only).
function makePrismaStub(opts: { ownerId: string | null }) {
  return {
    $queryRawUnsafe: vi.fn(async () => {
      if (opts.ownerId === null) return [];
      return [{ user_id: opts.ownerId, status: 'open', exception_type: 'missed_punch' }];
    }),
    $executeRawUnsafe: vi.fn(async () => 1),
  };
}

function makeRbacStub() {
  return {
    assertCanSeeUser: vi.fn(),
    getVisibleUserIds: vi.fn(async () => ({ userIds: [], unrestricted: false, meta: { fromProjects: 0, fromPersons: 0 } })),
  };
}

function makeAuditStub() {
  return { record: vi.fn(async () => undefined) };
}

describe('ExceptionsController.resolve — self-resolve only', () => {
  it('throws NotFoundError when the exception does not exist', async () => {
    const prisma = makePrismaStub({ ownerId: null });
    const rbac = makeRbacStub();
    const audit = makeAuditStub();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ctrl = new ExceptionsController(prisma as any, rbac as any, audit as any);
    await expect(
      ctrl.resolve({ userId: '1', email: 'a', roles: [] }, '99', {}),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it('throws RbacForbiddenError when a non-owner attempts to resolve', async () => {
    const prisma = makePrismaStub({ ownerId: '20' });
    const rbac = makeRbacStub();
    const audit = makeAuditStub();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ctrl = new ExceptionsController(prisma as any, rbac as any, audit as any);
    await expect(
      ctrl.resolve({ userId: '10', email: 'mgr@e', roles: ['manager'] }, '5', {}),
    ).rejects.toBeInstanceOf(RbacForbiddenError);
  });

  it('owner can self-resolve; UPDATE issued + audit row written', async () => {
    const prisma = makePrismaStub({ ownerId: '10' });
    const rbac = makeRbacStub();
    const audit = makeAuditStub();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ctrl = new ExceptionsController(prisma as any, rbac as any, audit as any);
    const r = await ctrl.resolve({ userId: '10', email: 'e@e', roles: ['employee'] }, '5', { note: 'fixed' });
    expect(r).toEqual({ ok: true });
    expect(prisma.$executeRawUnsafe).toHaveBeenCalledTimes(1);
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'exception.resolve', entityType: 'exception', entityId: '5' }),
    );
  });
});
