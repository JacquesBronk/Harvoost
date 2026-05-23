import { describe, it, expect, vi, beforeEach } from 'vitest';
import { LeaveController } from '../../src/leave/leave.controller';
import { RbacForbiddenError, ValidationFailedError, NotFoundError } from '@harvoost/shared';

// Tests Finding 1 (Leave approve/reject RBAC + self-approve guard).
// Validates the controller-level guard logic without booting Nest.

function makePrismaStub(opts: { leaveOwnerId: string | null }) {
  const executed: Array<{ sql: string; values: unknown[] }> = [];
  return {
    executed,
    $queryRawUnsafe: vi.fn(async (sql: string) => {
      if (sql.includes('FROM leave_requests') && sql.includes('SELECT user_id, status')) {
        if (opts.leaveOwnerId === null) return [];
        return [{ user_id: opts.leaveOwnerId, status: 'pending' }];
      }
      return [];
    }),
    $executeRawUnsafe: vi.fn(async (sql: string, ...values: unknown[]) => {
      executed.push({ sql, values });
      return 1;
    }),
  };
}

function makeRbacStub(opts: { allowed: boolean }) {
  return {
    assertCanSeeUser: vi.fn(async () => {
      if (!opts.allowed) throw new RbacForbiddenError();
    }),
  };
}

function makeAuditStub() {
  return { record: vi.fn(async () => undefined) };
}

const actor = { userId: '10', email: 'mgr@example.com', roles: ['manager'] };

describe('LeaveController approve — RBAC + self-approve guard', () => {
  let prisma: ReturnType<typeof makePrismaStub>;
  let rbac: ReturnType<typeof makeRbacStub>;
  let audit: ReturnType<typeof makeAuditStub>;
  let ctrl: LeaveController;

  beforeEach(() => {
    prisma = makePrismaStub({ leaveOwnerId: '20' });
    rbac = makeRbacStub({ allowed: true });
    audit = makeAuditStub();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ctrl = new LeaveController(prisma as any, rbac as any, audit as any);
  });

  it('approve: throws NotFoundError when leave_request does not exist', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const p = makePrismaStub({ leaveOwnerId: null });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const c = new LeaveController(p as any, rbac as any, audit as any);
    await expect(c.approve(actor, '999')).rejects.toBeInstanceOf(NotFoundError);
  });

  it('approve: throws ValidationFailedError when actor self-approves', async () => {
    prisma = makePrismaStub({ leaveOwnerId: actor.userId });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ctrl = new LeaveController(prisma as any, rbac as any, audit as any);
    await expect(ctrl.approve(actor, '5')).rejects.toBeInstanceOf(ValidationFailedError);
  });

  it('approve: throws RbacForbiddenError when requester cannot see the leave-owner', async () => {
    rbac = makeRbacStub({ allowed: false });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ctrl = new LeaveController(prisma as any, rbac as any, audit as any);
    await expect(ctrl.approve(actor, '5')).rejects.toBeInstanceOf(RbacForbiddenError);
    expect(rbac.assertCanSeeUser).toHaveBeenCalledWith(actor.userId, '20');
  });

  it('approve: happy path — RBAC visible, not self, UPDATE issued, audit row written', async () => {
    const result = await ctrl.approve(actor, '5');
    expect(result).toEqual({ ok: true });
    expect(rbac.assertCanSeeUser).toHaveBeenCalledWith(actor.userId, '20');
    // The UPDATE is the only $executeRawUnsafe besides the audit insert; audit is mocked separately.
    expect(prisma.$executeRawUnsafe).toHaveBeenCalledTimes(1);
    const [updateCall] = prisma.executed;
    expect(updateCall.sql).toMatch(/UPDATE leave_requests/);
    expect(updateCall.sql).toMatch(/status = 'approved'/);
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'leave.approve', entityType: 'leave_request', entityId: '5' }),
    );
  });

  it('reject: requires reason via Zod (caller passes through pipe); same RBAC + self guards apply', async () => {
    // The handler is type-safe — body type is already validated by the ZodValidationPipe.
    // Here we just verify the cross-user guard plus audit + UPDATE.
    await ctrl.reject(actor, '5', { reason: 'Out of capacity this week.' });
    expect(rbac.assertCanSeeUser).toHaveBeenCalledWith(actor.userId, '20');
    const updateCalls = prisma.executed.filter((e) => e.sql.includes('UPDATE leave_requests'));
    expect(updateCalls).toHaveLength(1);
    expect(updateCalls[0].sql).toMatch(/status = 'rejected'/);
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'leave.reject', reason: 'Out of capacity this week.' }),
    );
  });
});
