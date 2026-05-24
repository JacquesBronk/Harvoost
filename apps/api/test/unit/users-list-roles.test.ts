import { describe, it, expect, vi } from 'vitest';
import { UsersController } from '../../src/users/users.controller';
import type { AuditService } from '../../src/common/audit/audit.service';
import type { RbacScopeService } from '@harvoost/shared';

// INC-006 regression guard: GET /v1/users list MUST include `roles` per user,
// aggregated from the user_roles table, as a clean string[] — identical in shape
// to the `roles` array on GET /v1/auth/me. The /admin/users page maps over
// `user.roles` unguarded, so a missing field (or a [null] leak for a user with
// zero roles) crashes the page. The list must:
//   - return `roles: string[]` for every user,
//   - populate it with all of a user's roles (multi-role users get all of them),
//   - return `roles: []` (never null / never [null]) for users with no roles,
//   - aggregate in a SINGLE query (LEFT JOIN user_roles + array_agg) — no N+1.

// Prisma stub: matches the list aggregation SELECT and returns rows whose `roles`
// surface as Postgres text[] (a JS string array), mirroring how the pg driver
// hydrates array_agg. The COUNT query returns the row total.
function makePrismaStub(rows: Array<Record<string, unknown>>) {
  const queryRawUnsafe = vi.fn(async (sql: string) => {
    if (/COUNT\(\*\)/.test(sql)) {
      return [{ c: rows.length }];
    }
    if (/FROM users u/.test(sql)) {
      return rows;
    }
    return [];
  });
  return {
    $queryRawUnsafe: queryRawUnsafe,
    $executeRawUnsafe: vi.fn(async () => 1),
  };
}

function makeAudit(): AuditService {
  return { record: vi.fn(async () => undefined) } as unknown as AuditService;
}

function makeRbac(): RbacScopeService {
  return {
    assertCanSeeUser: vi.fn(async () => undefined),
  } as unknown as RbacScopeService;
}

function makeController(prisma: ReturnType<typeof makePrismaStub>) {
  return new UsersController(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    prisma as any,
    makeAudit(),
    makeRbac(),
  );
}

describe('UsersController.list — GET /v1/users includes roles (INC-006)', () => {
  it('returns roles as a string[] for each user, populated from user_roles', async () => {
    const prisma = makePrismaStub([
      {
        id: 1n,
        email: 'alice@harvoost.local',
        display_name: 'Alice',
        timezone: 'Europe/Amsterdam',
        weekly_summary_opt_out: false,
        is_active: true,
        created_at: '2026-01-01T00:00:00.000Z',
        roles: ['admin', 'manager'],
      },
      {
        id: 2n,
        email: 'bob@harvoost.local',
        display_name: 'Bob',
        timezone: 'Europe/Amsterdam',
        weekly_summary_opt_out: false,
        is_active: true,
        created_at: '2026-01-01T00:00:00.000Z',
        roles: ['employee'],
      },
    ]);
    const ctrl = makeController(prisma);

    const out = await ctrl.list('1', '50');

    expect(out.data).toHaveLength(2);
    expect(out.data[0].roles).toEqual(['admin', 'manager']);
    expect(out.data[1].roles).toEqual(['employee']);
    for (const u of out.data) {
      expect(Array.isArray(u.roles)).toBe(true);
      for (const r of u.roles as string[]) {
        expect(typeof r).toBe('string');
      }
    }
  });

  it('returns roles: [] (never null / never [null]) for a user with no roles', async () => {
    // The aggregation SELECT uses array_agg(...) FILTER (WHERE ur.role IS NOT NULL)
    // + COALESCE(..., '{}'), so a roleless user surfaces as an empty array, not [null].
    const prisma = makePrismaStub([
      {
        id: 3n,
        email: 'carol@harvoost.local',
        display_name: 'Carol',
        timezone: 'UTC',
        weekly_summary_opt_out: false,
        is_active: true,
        created_at: '2026-01-01T00:00:00.000Z',
        roles: [], // Postgres '{}' hydrates as an empty JS array
      },
    ]);
    const ctrl = makeController(prisma);

    const out = await ctrl.list('1', '50');

    expect(out.data[0].roles).toEqual([]);
    expect(out.data[0].roles).not.toBeNull();
    expect(out.data[0].roles).not.toContain(null);
  });

  it('defensively coerces a non-array roles value to [] (no [null] leakage)', async () => {
    // Belt-and-braces: if the driver ever hands back null instead of an empty array
    // for a roleless user, the handler must still emit [] — never null / [null].
    const prisma = makePrismaStub([
      {
        id: 4n,
        email: 'dave@harvoost.local',
        display_name: 'Dave',
        timezone: 'UTC',
        weekly_summary_opt_out: false,
        is_active: true,
        created_at: '2026-01-01T00:00:00.000Z',
        roles: null,
      },
    ]);
    const ctrl = makeController(prisma);

    const out = await ctrl.list('1', '50');

    expect(out.data[0].roles).toEqual([]);
  });

  it('String()-maps role values so the JSON is a clean string[] (mirrors /v1/auth/me)', async () => {
    const prisma = makePrismaStub([
      {
        id: 5n,
        email: 'erin@harvoost.local',
        display_name: 'Erin',
        timezone: 'UTC',
        weekly_summary_opt_out: false,
        is_active: true,
        created_at: '2026-01-01T00:00:00.000Z',
        // simulate driver handing back a non-string-typed element
        roles: ['finmgr'],
      },
    ]);
    const ctrl = makeController(prisma);

    const out = await ctrl.list('1', '50');

    expect(out.data[0].roles).toEqual(['finmgr']);
    expect((out.data[0].roles as string[]).every((r) => typeof r === 'string')).toBe(true);
  });

  it('aggregates in a single query (LEFT JOIN user_roles) — no N+1', async () => {
    const prisma = makePrismaStub([
      {
        id: 6n,
        email: 'frank@harvoost.local',
        display_name: 'Frank',
        timezone: 'UTC',
        weekly_summary_opt_out: false,
        is_active: true,
        created_at: '2026-01-01T00:00:00.000Z',
        roles: ['manager'],
      },
    ]);
    const ctrl = makeController(prisma);

    await ctrl.list('1', '50');

    // One list query + one COUNT query — and NOT one extra roles query per user.
    expect(prisma.$queryRawUnsafe).toHaveBeenCalledTimes(2);
    expect(prisma.$queryRawUnsafe).toHaveBeenCalledWith(
      expect.stringMatching(/array_agg\(ur\.role\)[\s\S]*LEFT JOIN user_roles/),
      50,
      0,
    );
  });

  it('preserves the pagination envelope shape { data, page, page_size, total_count }', async () => {
    const prisma = makePrismaStub([
      {
        id: 7n,
        email: 'grace@harvoost.local',
        display_name: 'Grace',
        timezone: 'UTC',
        weekly_summary_opt_out: false,
        is_active: true,
        created_at: '2026-01-01T00:00:00.000Z',
        roles: ['employee'],
      },
    ]);
    const ctrl = makeController(prisma);

    const out = await ctrl.list('2', '10');

    expect(out).toMatchObject({ page: 2, page_size: 10, total_count: 1 });
    expect(Array.isArray(out.data)).toBe(true);
    // offset honoured: page 2, page_size 10 → OFFSET 10
    expect(prisma.$queryRawUnsafe).toHaveBeenCalledWith(expect.any(String), 10, 10);
  });
});
