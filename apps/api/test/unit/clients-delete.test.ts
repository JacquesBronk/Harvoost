import { describe, it, expect, vi } from 'vitest';
import { ClientsController } from '../../src/clients/clients.controller';
import { RolesGuard } from '../../src/auth/roles.guard';
import { ROLES_KEY } from '../../src/common/roles.decorator';
import { RbacForbiddenError, ValidationFailedError } from '@harvoost/shared';
import { Reflector } from '@nestjs/core';

// INC-004 expansion — ClientsController.remove (DELETE /v1/clients/{id}).
// Admin-only. Deletes an unreferenced client + records a client.delete audit.
// A client still referenced by a project hits the projects.client_id FK
// (ON DELETE RESTRICT → Postgres 23503), which must surface as a clean
// ValidationFailedError, NOT a raw 500.

function makePrismaStub(opts: { fkViolation?: boolean } = {}) {
  return {
    $executeRawUnsafe: vi.fn(async (sql: string) => {
      if (opts.fkViolation && sql.includes('DELETE FROM clients')) {
        throw Object.assign(
          new Error(
            'update or delete on table "clients" violates foreign key constraint "projects_client_id_fkey" on table "projects"',
          ),
          { code: '23503' },
        );
      }
      return 1;
    }),
  };
}

function makeAuditStub() {
  return { record: vi.fn(async () => undefined) };
}

const admin = { userId: '1', email: 'a@x', roles: ['admin'] };

function runGuard(handler: (...args: unknown[]) => unknown, user: { roles: string[] } | undefined) {
  const guard = new RolesGuard(new Reflector());
  const ctx = {
    getHandler: () => handler,
    getClass: () => ClientsController,
    switchToHttp: () => ({ getRequest: () => ({ user }) }),
  } as never;
  return guard.canActivate(ctx);
}

describe('ClientsController.remove — RBAC', () => {
  it('carries @Roles(admin) metadata (not widened to finmgr)', () => {
    const roles = Reflect.getMetadata(ROLES_KEY, ClientsController.prototype.remove);
    expect(roles).toEqual(['admin']);
  });

  it('RolesGuard 403s a finmgr (delete is admin-only)', () => {
    expect(() => runGuard(ClientsController.prototype.remove, { roles: ['finmgr'] })).toThrow(
      RbacForbiddenError,
    );
  });

  it('RolesGuard allows an admin', () => {
    expect(runGuard(ClientsController.prototype.remove, admin)).toBe(true);
  });
});

describe('ClientsController.remove — behavior', () => {
  it('deletes an unreferenced client and records a client.delete audit', async () => {
    const prisma = makePrismaStub();
    const audit = makeAuditStub();
    const ctrl = new ClientsController(prisma as never, audit as never);
    const r = await ctrl.remove(admin, '12');
    expect(r).toEqual({ ok: true });
    expect(prisma.$executeRawUnsafe).toHaveBeenCalledWith(
      expect.stringContaining('DELETE FROM clients'),
      '12',
    );
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'client.delete', entityType: 'client', entityId: '12', actorId: '1' }),
    );
  });

  it('maps a 23503 FK violation to a clean ValidationFailedError (not 500) and does NOT audit', async () => {
    const prisma = makePrismaStub({ fkViolation: true });
    const audit = makeAuditStub();
    const ctrl = new ClientsController(prisma as never, audit as never);
    await expect(ctrl.remove(admin, '12')).rejects.toBeInstanceOf(ValidationFailedError);
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('the mapped FK error is a 400-class domain error with a CLIENT_HAS_PROJECTS detail', async () => {
    const prisma = makePrismaStub({ fkViolation: true });
    const ctrl = new ClientsController(prisma as never, makeAuditStub() as never);
    await expect(ctrl.remove(admin, '12')).rejects.toMatchObject({
      httpStatus: 400,
      details: { code: 'CLIENT_HAS_PROJECTS' },
    });
  });
});
