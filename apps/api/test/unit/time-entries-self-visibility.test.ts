import { describe, it, expect, vi, beforeEach } from 'vitest';
import { HTTP_CODE_METADATA } from '@nestjs/common/constants';
import { TimeEntriesController } from '../../src/time-entries/time-entries.controller';
import { IdempotencyService } from '../../src/common/idempotency/idempotency.service';
import type { RbacScopeService } from '@harvoost/shared';
import type { CurrentUserPayload } from '../../src/common/current-user.decorator';

// FEAT-002 (issue #6) — employee self-visibility on GET /v1/time-entries.
// The list ANDs visible-users with visible-projects. A plain employee anchors NO project as a
// manager, so pre-FEAT-002 their visible-projects was empty → empty list (they could not see
// their own work). The fix: (a) getVisibleProjectIds now unions the caller's MEMBER projects,
// and (b) the list ALWAYS includes the caller's own user_id (self-scope). We assert here that
// the SELECT binds BOTH the self user-id and the visible-project ids.

function makePrisma() {
  const calls: Array<{ sql: string; values: unknown[] }> = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const stub: any = {
    calls,
    $queryRawUnsafe: vi.fn(async (sql: string, ...values: unknown[]) => {
      calls.push({ sql, values });
      if (sql.includes('FROM time_entries te')) {
        // Return one of the caller's own entries.
        return [
          {
            id: '500',
            user_id: '3',
            project_id: '1',
            task_id: null,
            notes: null,
            start_at: new Date('2026-05-20T08:00:00Z'),
            end_at: new Date('2026-05-20T09:00:00Z'),
            status: 'draft',
            billable: true,
          },
        ];
      }
      return [];
    }),
    $executeRawUnsafe: vi.fn(async () => 1),
  };
  stub.$transaction = vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(stub));
  return stub;
}

// RBAC stub mirroring a plain EMPLOYEE: getVisibleUserIds returns ONLY self (the cascade's
// {M itself}); getVisibleProjectIds returns the employee's member-projects (post-FEAT-002).
function makeEmployeeRbac(opts: { selfUserId: string; memberProjects: string[]; cascadeUsers?: string[] }): RbacScopeService {
  return {
    getVisibleUserIds: async () => ({
      userIds: opts.cascadeUsers ?? [opts.selfUserId],
      meta: { fromProjects: 0, fromPersons: 0 },
      unrestricted: false,
    }),
    getVisibleProjectIds: async () => ({
      projectIds: opts.memberProjects,
      meta: { fromProjects: 0, fromPersons: 0 },
      unrestricted: false,
    }),
    withSelfScope: (userId: string) => ({ userIds: [userId], selfOnly: true as const }),
  } as unknown as RbacScopeService;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makePeriods(): any {
  return {
    getUserTz: async () => 'Africa/Johannesburg',
    resolveWeek: async () => ({ isoYear: 2026, isoWeek: 21, weekStartDate: '2026-05-18' }),
    assertPeriodWritable: async () => undefined,
    recomputePeriod: async () => undefined,
  };
}

function makeController(prisma: ReturnType<typeof makePrisma>, rbac: RbacScopeService): TimeEntriesController {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const idem = new IdempotencyService(prisma as any);
  return new TimeEntriesController(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    prisma as any,
    idem,
    rbac,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    { record: async () => undefined } as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    { emit: () => {}, subscribe: () => ({ subject: {}, unsubscribe: () => {} }), subscriberCount: () => 0 } as any,
    makePeriods(),
  );
}

const employee: CurrentUserPayload = { userId: '3', email: 'bob@h.local', roles: ['employee'] };

describe('GET /v1/time-entries — employee self-visibility (FEAT-002 issue #6)', () => {
  let prisma: ReturnType<typeof makePrisma>;

  beforeEach(() => {
    prisma = makePrisma();
  });

  it('an employee sees their OWN entries — self user_id is in the bound visible set', async () => {
    const rbac = makeEmployeeRbac({ selfUserId: '3', memberProjects: ['1', '2'] });
    const ctrl = makeController(prisma, rbac);
    const out = await ctrl.list(employee, { limit: 50 } as never);
    expect(out.data).toHaveLength(1);
    expect(out.data[0]).toMatchObject({ id: '500', user_id: '3' });
    // The list SELECT binds the self user-id in the user ANY(...) array.
    const listCall = prisma.calls.find((c) => /FROM time_entries te/.test(c.sql));
    expect(listCall!.sql).toMatch(/te\.user_id = ANY\(\$1::bigint\[\]\)/);
    expect(listCall!.values[0]).toContain('3'); // self is present
  });

  it('the SELECT also scopes to the employee MEMBER projects (no non-member projects)', async () => {
    const rbac = makeEmployeeRbac({ selfUserId: '3', memberProjects: ['1', '2'] });
    const ctrl = makeController(prisma, rbac);
    await ctrl.list(employee, { limit: 50 } as never);
    const listCall = prisma.calls.find((c) => /FROM time_entries te/.test(c.sql));
    expect(listCall!.sql).toMatch(/te\.project_id = ANY\(\$2::bigint\[\]\)/);
    expect(listCall!.values[1]).toEqual(['1', '2']); // member projects only
  });

  it('self is ALWAYS included even if the RBAC cascade omitted it (hardened self-scope)', async () => {
    // Pathological: cascade returns OTHER users but not self → self must be re-added.
    const rbac = makeEmployeeRbac({ selfUserId: '3', memberProjects: ['1'], cascadeUsers: ['7', '8'] });
    const ctrl = makeController(prisma, rbac);
    await ctrl.list(employee, { limit: 50 } as never);
    const listCall = prisma.calls.find((c) => /FROM time_entries te/.test(c.sql));
    const boundUsers = listCall!.values[0] as string[];
    expect(boundUsers).toContain('3'); // self re-injected
    expect(new Set(boundUsers)).toEqual(new Set(['7', '8', '3']));
  });

  it('does NOT widen to another user — the user filter is the bounded set, not a wildcard', async () => {
    const rbac = makeEmployeeRbac({ selfUserId: '3', memberProjects: ['1'] });
    const ctrl = makeController(prisma, rbac);
    await ctrl.list(employee, { limit: 50 } as never);
    const listCall = prisma.calls.find((c) => /FROM time_entries te/.test(c.sql));
    // user filter present (bounded), never dropped to unrestricted for a plain employee.
    expect(listCall!.sql).toMatch(/te\.user_id = ANY/);
    expect(listCall!.values[0]).toEqual(['3']);
  });

  it('admin (unrestricted) is unaffected — no bounded user/project ANY clause', async () => {
    const adminRbac = {
      getVisibleUserIds: async () => ({ userIds: ['1', '3', '7'], meta: { fromProjects: 0, fromPersons: 0 }, unrestricted: true }),
      getVisibleProjectIds: async () => ({ projectIds: ['1', '2'], meta: { fromProjects: 0, fromPersons: 0 }, unrestricted: true }),
      withSelfScope: (userId: string) => ({ userIds: [userId], selfOnly: true as const }),
    } as unknown as RbacScopeService;
    const ctrl = makeController(prisma, adminRbac);
    const admin: CurrentUserPayload = { userId: '1', email: 'a@h.local', roles: ['admin'] };
    await ctrl.list(admin, { limit: 50 } as never);
    const listCall = prisma.calls.find((c) => /FROM time_entries te/.test(c.sql));
    expect(listCall!.sql).not.toMatch(/te\.user_id = ANY/);
    expect(listCall!.sql).not.toMatch(/te\.project_id = ANY/);
  });
});

describe('POST /v1/time-entries/{id}/submit — @HttpCode(200) aligns with the spec', () => {
  it('the submit handler carries HttpCode 200 metadata (not the 201 @Post default)', () => {
    const code = Reflect.getMetadata(HTTP_CODE_METADATA, TimeEntriesController.prototype.submit);
    expect(code).toBe(200);
  });
});
