import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { TimeEntriesController } from '../../src/time-entries/time-entries.controller';
import { IdempotencyService } from '../../src/common/idempotency/idempotency.service';
import type { RbacScopeService } from '@harvoost/shared';
import type { CurrentUserPayload } from '../../src/common/current-user.decorator';

// FEAT-001 regression (GitHub #5) — non-null task_id end-to-end against a REAL DB.
//
// Latent since v0.1.0: the start/switch/createManual INSERTs in
// time-entries.controller.ts bound `task_id` WITHOUT a `::bigint` cast (while
// project_id IS cast). When the FEAT-001 task picker first sent a non-null
// task_id (a string, e.g. "1"), Postgres read the parameter as `text` against
// the `bigint` task_id column and raised:
//   42804  column "task_id" is of type bigint but expression is of type text
// → HTTP 500. `null::bigint` is valid, so the pre-existing null-task path was
// unaffected — which is why the mocked-Prisma unit tests never caught it.
//
// This test drives the controller against the seeded Postgres instance with a
// real project + its "General" task, so the INSERT's text→bigint coercion runs
// for real. Against the UNPATCHED code each handler throws the 42804 error here;
// the `::bigint` cast on the task_id placeholder is the only thing making it pass.
//
// Approach: instantiate the controller directly (mirroring the construction in
// test/unit/time-entries-controller.test.ts) but with a REAL PrismaClient instead
// of the mocked stub, plus the real IdempotencyService. The full-AppModule e2e
// harness cannot connect Prisma in vitest (PrismaService.require('@harvoost/db')
// resolves to TS source), so a direct real-DB controller test is the reliable way
// to exercise the raw SQL.

// Mirror the BigInt JSON polyfill installed in apps/api/src/main.ts (and in
// test/unit/bigint-json-serialization.test.ts). Calling the controller directly
// bypasses main.ts, so without this IdempotencyService.store()'s JSON.stringify
// throws on the bigint id/project_id/task_id columns the row carries.
(BigInt.prototype as unknown as { toJSON: () => string }).toJSON = function () {
  return this.toString();
};

// @prisma/client is a runtime dep of @harvoost/db and resolvable from apps/api.
// eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
const { PrismaClient } = require('@prisma/client');

const DB_URL =
  process.env.DATABASE_URL ?? 'postgresql://harvoost:dev@localhost:5432/harvoost?sslmode=disable';

// Seeded fixture: carol (user 7) is an employee + member of project 1, whose
// "General" task is id 1 (see packages/db/prisma/seed.ts).
const TEST_USER_ID = '7';
const TEST_PROJECT_ID = '1';
const TEST_TASK_ID = '1';

const EMPLOYEE: CurrentUserPayload = {
  userId: TEST_USER_ID,
  email: 'carol@harvoost.local',
  roles: ['employee'],
};

// start/switch/createManual never touch RBAC; a no-op stub matches the unit-test fixture.
function makeRbac(): RbacScopeService {
  return {
    getVisibleUserIds: async () => ({ userIds: [TEST_USER_ID], meta: { fromProjects: 0, fromPersons: 0 }, unrestricted: false }),
    getVisibleProjectIds: async () => ({ projectIds: [TEST_PROJECT_ID], meta: { fromProjects: 0, fromPersons: 0 }, unrestricted: false }),
  } as unknown as RbacScopeService;
}

const noopAudit = { record: async () => undefined } as never;
const noopSync = {
  emit: () => {},
  subscribe: () => ({ subject: {}, unsubscribe: () => {} }),
  subscriberCount: () => 0,
} as never;

describe('time-entries non-null task_id (FEAT-001 regression, GitHub #5) — real DB', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let prisma: any;
  let ctrl: TimeEntriesController;
  let dbReady = false;

  beforeAll(async () => {
    prisma = new PrismaClient({ datasources: { db: { url: DB_URL } } });
    try {
      await prisma.$connect();
      const rows = await prisma.$queryRawUnsafe(
        `SELECT 1 AS ok FROM project_tasks
         WHERE id = $1::bigint AND project_id = $2::bigint AND is_active = TRUE`,
        TEST_TASK_ID,
        TEST_PROJECT_ID,
      );
      dbReady = Array.isArray(rows) && rows.length > 0;
    } catch {
      dbReady = false;
    }

    const idem = new IdempotencyService(prisma);
    ctrl = new TimeEntriesController(prisma, idem, makeRbac(), noopAudit, noopSync);

    if (dbReady) {
      // Clean slate: drop any existing entries + idempotency keys for the test user
      // so the one-running-per-user index and overlap GIST don't surface as 409s.
      await prisma.$executeRawUnsafe(`DELETE FROM time_entries WHERE user_id = $1::bigint`, TEST_USER_ID);
      await prisma.$executeRawUnsafe(`DELETE FROM idempotency_keys WHERE user_id = $1::bigint`, TEST_USER_ID);
    }
  });

  afterEach(async () => {
    if (dbReady) {
      await prisma.$executeRawUnsafe(`DELETE FROM time_entries WHERE user_id = $1::bigint`, TEST_USER_ID);
      await prisma.$executeRawUnsafe(`DELETE FROM idempotency_keys WHERE user_id = $1::bigint`, TEST_USER_ID);
    }
  });

  afterAll(async () => {
    await prisma?.$disconnect?.();
  });

  it('start with a non-null task_id persists task_id (no 42804/500)', async () => {
    if (!dbReady) {
      console.warn('[skip] seeded project_tasks fixture not reachable — skipping start case');
      return;
    }
    // Against the unpatched ($3 uncast) code this rejects with Postgres 42804.
    const out = await ctrl.start(EMPLOYEE, randomUUID(), {
      project_id: TEST_PROJECT_ID,
      task_id: TEST_TASK_ID,
    });
    // normalizeRow returns raw bigint columns; main.ts's polyfill renders them as
    // strings over HTTP. We compare via String() to be representation-agnostic.
    expect((out as Record<string, unknown>).status).toBe('running');
    expect(String((out as Record<string, unknown>).project_id)).toBe(TEST_PROJECT_ID);
    // task_id surfaces as the string-serialized bigint.
    expect(String((out as Record<string, unknown>).task_id)).toBe(TEST_TASK_ID);

    const persisted = await prisma.$queryRawUnsafe(
      `SELECT task_id FROM time_entries WHERE id = $1::bigint`,
      String((out as Record<string, unknown>).id),
    );
    expect(persisted).toHaveLength(1);
    expect(String(persisted[0].task_id)).toBe(TEST_TASK_ID);
  });

  it('switch with a non-null task_id while a timer runs persists the new task_id', async () => {
    if (!dbReady) {
      console.warn('[skip] seeded project_tasks fixture not reachable — skipping switch case');
      return;
    }
    // Arrange: a running timer with no task so switch has something to stop.
    await ctrl.start(EMPLOYEE, randomUUID(), { project_id: TEST_PROJECT_ID });

    const out = await ctrl.switch(EMPLOYEE, randomUUID(), {
      project_id: TEST_PROJECT_ID,
      task_id: TEST_TASK_ID,
    });
    expect((out as Record<string, unknown>).status).toBe('running');
    expect(String((out as Record<string, unknown>).project_id)).toBe(TEST_PROJECT_ID);
    expect(String((out as Record<string, unknown>).task_id)).toBe(TEST_TASK_ID);

    const persisted = await prisma.$queryRawUnsafe(
      `SELECT task_id FROM time_entries WHERE id = $1::bigint`,
      String((out as Record<string, unknown>).id),
    );
    expect(persisted).toHaveLength(1);
    expect(String(persisted[0].task_id)).toBe(TEST_TASK_ID);
  });

  it('manual create with a non-null task_id persists task_id', async () => {
    if (!dbReady) {
      console.warn('[skip] seeded project_tasks fixture not reachable — skipping manual case');
      return;
    }
    // A unique past window so the overlap GIST pre-check stays clear.
    const out = await ctrl.createManual(EMPLOYEE, {
      project_id: TEST_PROJECT_ID,
      task_id: TEST_TASK_ID,
      start_at: '2026-04-01T08:00:00.000Z',
      end_at: '2026-04-01T10:00:00.000Z',
    });
    expect((out as Record<string, unknown>).status).toBe('draft');
    expect(String((out as Record<string, unknown>).project_id)).toBe(TEST_PROJECT_ID);
    expect(String((out as Record<string, unknown>).task_id)).toBe(TEST_TASK_ID);

    const persisted = await prisma.$queryRawUnsafe(
      `SELECT task_id FROM time_entries WHERE id = $1::bigint`,
      String((out as Record<string, unknown>).id),
    );
    expect(persisted).toHaveLength(1);
    expect(String(persisted[0].task_id)).toBe(TEST_TASK_ID);
  });
});
