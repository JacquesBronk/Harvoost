import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { TimeEntriesController } from '../../src/time-entries/time-entries.controller';
import { IdempotencyService } from '../../src/common/idempotency/idempotency.service';
import { PeriodService } from '../../src/timesheet-periods/period.service';
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

// The seeded dev DB does not pre-create `idempotency_keys` (the IdempotencyService creates it
// lazily via the same `CREATE TABLE IF NOT EXISTS` on first lookup/store). The cleanup DELETEs
// below run BEFORE any service call, so we create it defensively here — mirroring the service's
// own DDL in src/common/idempotency/idempotency.service.ts — so the cleanup never 42P01s.
const ENSURE_IDEMPOTENCY_TABLE = `
  CREATE TABLE IF NOT EXISTS idempotency_keys (
    id BIGSERIAL PRIMARY KEY,
    user_id BIGINT NOT NULL,
    idempotency_key TEXT NOT NULL,
    body_hash TEXT NOT NULL,
    response JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (user_id, idempotency_key)
  );
`;

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

// start/switch/createManual never touch RBAC; list() additionally calls withSelfScope. The stub
// scopes visibility to the test user + project so list() returns only this fixture's rows.
function makeRbac(): RbacScopeService {
  return {
    getVisibleUserIds: async () => ({ userIds: [TEST_USER_ID], meta: { fromProjects: 0, fromPersons: 0 }, unrestricted: false }),
    getVisibleProjectIds: async () => ({ projectIds: [TEST_PROJECT_ID], meta: { fromProjects: 0, fromPersons: 0 }, unrestricted: false }),
    withSelfScope: (userId: string) => ({ userIds: [userId], selfOnly: true }),
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
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const periods = new PeriodService(prisma as any);
    ctrl = new TimeEntriesController(prisma, idem, makeRbac(), noopAudit, noopSync, periods);

    if (dbReady) {
      // Ensure the lazily-created idempotency table exists so the cleanup DELETE below
      // (which runs before any service call) does not 42P01 on the seeded dev DB.
      await prisma.$executeRawUnsafe(ENSURE_IDEMPOTENCY_TABLE);
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

// INC-009 (GitHub #21) — the time-entries READ endpoints (list + running) must return
// project_name (INNER join to projects) and task_name (LEFT join to project_tasks). The web
// week table / TimerBar render `entry.project_name`/`entry.task_name` with fallbacks; before
// the JOINs were added these were never sent, so the UI showed `Project #<id>` and `—`.
// This drives the controller against the seeded DB and asserts the names are present, and that
// task_name is null when an entry has no task while project_name stays populated.
describe('time-entries read endpoints return project_name/task_name (INC-009, #21) — real DB', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let prisma: any;
  let ctrl: TimeEntriesController;
  let dbReady = false;
  let seededProjectName: string | null = null;
  let seededTaskName: string | null = null;

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
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const periods = new PeriodService(prisma as any);
    ctrl = new TimeEntriesController(prisma, idem, makeRbac(), noopAudit, noopSync, periods);

    if (dbReady) {
      // Resolve the seeded project + task names so the assertions compare against the real
      // values rather than hard-coding seed strings.
      const projRows = await prisma.$queryRawUnsafe(
        `SELECT name FROM projects WHERE id = $1::bigint`,
        TEST_PROJECT_ID,
      );
      seededProjectName = projRows.length > 0 ? String(projRows[0].name) : null;
      const taskRows = await prisma.$queryRawUnsafe(
        `SELECT name FROM project_tasks WHERE id = $1::bigint`,
        TEST_TASK_ID,
      );
      seededTaskName = taskRows.length > 0 ? String(taskRows[0].name) : null;

      await prisma.$executeRawUnsafe(ENSURE_IDEMPOTENCY_TABLE);
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

  it('seeded task 1 is "General"', () => {
    if (!dbReady) {
      console.warn('[skip] seeded project_tasks fixture not reachable — skipping name fixture case');
      return;
    }
    expect(seededTaskName).toBe('General');
    expect(seededProjectName).toBeTruthy();
  });

  it('running() returns project_name + task_name after a start with a task', async () => {
    if (!dbReady) {
      console.warn('[skip] seeded project_tasks fixture not reachable — skipping running-with-task case');
      return;
    }
    await ctrl.start(EMPLOYEE, randomUUID(), {
      project_id: TEST_PROJECT_ID,
      task_id: TEST_TASK_ID,
    });

    const res = await ctrl.running(EMPLOYEE);
    const data = res.data as Record<string, unknown> | null;
    expect(data).not.toBeNull();
    expect(data!.project_name).toBe(seededProjectName);
    expect(data!.task_name).toBe('General');
  });

  it('list() running row carries project_name + task_name', async () => {
    if (!dbReady) {
      console.warn('[skip] seeded project_tasks fixture not reachable — skipping list-with-task case');
      return;
    }
    await ctrl.start(EMPLOYEE, randomUUID(), {
      project_id: TEST_PROJECT_ID,
      task_id: TEST_TASK_ID,
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = await ctrl.list(EMPLOYEE, { limit: 50 } as any);
    const rows = res.data as Array<Record<string, unknown>>;
    const running = rows.find((r) => r.status === 'running');
    expect(running).toBeDefined();
    expect(running!.project_name).toBe(seededProjectName);
    expect(running!.task_name).toBe('General');
  });

  it('task_name is null when started with no task, project_name still populated', async () => {
    if (!dbReady) {
      console.warn('[skip] seeded project_tasks fixture not reachable — skipping no-task case');
      return;
    }
    await ctrl.start(EMPLOYEE, randomUUID(), { project_id: TEST_PROJECT_ID });

    const res = await ctrl.running(EMPLOYEE);
    const data = res.data as Record<string, unknown> | null;
    expect(data).not.toBeNull();
    expect(data!.task_name).toBeNull();
    expect(data!.project_name).toBe(seededProjectName);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const listRes = await ctrl.list(EMPLOYEE, { limit: 50 } as any);
    const running = (listRes.data as Array<Record<string, unknown>>).find((r) => r.status === 'running');
    expect(running).toBeDefined();
    expect(running!.task_name).toBeNull();
    expect(running!.project_name).toBe(seededProjectName);
  });

  // #21 follow-up — the list SELECT also computes `hours` from (end_at - start_at).
  // A running entry has no end_at, so hours is null (UI renders "—"); a stopped/closed
  // entry returns a real number. Before this, the Hours column was "—" for every row.
  it('list() returns numeric hours for a stopped entry; null while running', async () => {
    if (!dbReady) {
      console.warn('[skip] seeded fixture not reachable — skipping hours case');
      return;
    }
    await ctrl.start(EMPLOYEE, randomUUID(), { project_id: TEST_PROJECT_ID });

    // While running (end_at null) the computed hours is null.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let res = await ctrl.list(EMPLOYEE, { limit: 50 } as any);
    let row = (res.data as Array<Record<string, unknown>>).find((r) => r.status === 'running');
    expect(row).toBeDefined();
    expect(row!.hours).toBeNull();

    // After stopping, the entry is closed and hours is a real (>= 0) number.
    await ctrl.stop(EMPLOYEE, randomUUID(), {});
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    res = await ctrl.list(EMPLOYEE, { limit: 50 } as any);
    row = (res.data as Array<Record<string, unknown>>).find((r) => r.status !== 'running');
    expect(row).toBeDefined();
    expect(typeof row!.hours).toBe('number');
    expect(row!.hours as number).toBeGreaterThanOrEqual(0);
  });
});
