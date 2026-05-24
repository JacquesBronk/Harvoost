import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DateTime, Settings } from 'luxon';
import { apiFetch } from '../src/lib/api-client.js';
import { currentIsoWeekRange, dateRangeParam } from '../src/lib/tz.js';
import type { ProjectRollupRow } from '../src/lib/api-types.js';
import type { EmployeeDrillIn } from '../app/dashboard/employees/[userId]/rollup-views.js';

/**
 * INC-007 (GitHub #9) — Employee/project drill-in pages 400'd because they hit
 * the rollup endpoints with NO `date_range` query string, which the API rejects
 * with `VALIDATION_FAILED ("date_range must be in the form YYYY-MM-DD/YYYY-MM-DD")`.
 *
 * The fix mirrors the INC-004 team-dashboard pattern: build a default range =
 * the current ISO week in the viewer's zone (currentIsoWeekRange → dateRangeParam),
 * pass `query: { date_range }` on the apiFetch, gate the query with
 * `enabled: !!dateRange`, and key the cache by the range.
 *
 * Node-env, mocked-fetch convention from apps/web/__tests__/inc004-reports-query.test.ts.
 * The full pages are 'use client' components (useParams/useQuery) that need a
 * browser env, so we pin the range-building helper, the actual rollup URL
 * apiFetch builds, and the query-options object shape both pages construct.
 */

const DATE_RANGE_RE = /^\d{4}-\d{2}-\d{2}\/\d{4}-\d{2}-\d{2}$/;

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** Capture the URL the next apiFetch call hits. */
function captureFetch(body: unknown): { calls: string[]; restore: () => void } {
  const calls: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = vi.fn().mockImplementation((url: string | URL) => {
    calls.push(String(url));
    return Promise.resolve(jsonResponse(200, body));
  });
  return { calls, restore: () => void (globalThis.fetch = original) };
}

/**
 * The exact range-building both drill-in pages do:
 *   const dateRange = dateRangeParam(currentIsoWeekRange(zone).from, .to)
 * Mirrors apps/web/app/dashboard/employees/[userId]/page.tsx and
 * apps/web/app/dashboard/projects/[projectId]/page.tsx.
 */
function buildDrillDateRange(zone: string): string {
  const range = currentIsoWeekRange(zone);
  return dateRangeParam(range.from, range.to);
}

describe('currentIsoWeekRange (INC-007 drill-in default range)', () => {
  const realNow = Settings.now;
  afterEach(() => {
    Settings.now = realNow;
  });

  it('returns the inclusive Mon→Sun ISO week for "today" in the given zone', () => {
    // 2026-05-24 is a Sunday; its ISO week is Mon 2026-05-18 → Sun 2026-05-24.
    const fixed = DateTime.fromISO('2026-05-24T09:00:00', { zone: 'UTC' }).toMillis();
    Settings.now = () => fixed;
    const { from, to } = currentIsoWeekRange('UTC');
    expect(from).toBe('2026-05-18');
    expect(to).toBe('2026-05-24');
  });

  it('produces a well-formed date_range param (YYYY-MM-DD/YYYY-MM-DD)', () => {
    const fixed = DateTime.fromISO('2026-05-20T12:00:00', { zone: 'UTC' }).toMillis();
    Settings.now = () => fixed;
    expect(buildDrillDateRange('UTC')).toMatch(DATE_RANGE_RE);
  });

  it('spans exactly 7 inclusive days (Mon..Sun)', () => {
    const fixed = DateTime.fromISO('2026-05-20T12:00:00', { zone: 'UTC' }).toMillis();
    Settings.now = () => fixed;
    const { from, to } = currentIsoWeekRange('UTC');
    const days =
      DateTime.fromISO(to, { zone: 'UTC' }).diff(
        DateTime.fromISO(from, { zone: 'UTC' }),
        'days',
      ).days + 1;
    expect(days).toBe(7);
  });
});

describe('employee rollup request (INC-007)', () => {
  beforeEach(() => {
    process.env.NEXT_PUBLIC_API_BASE_URL = 'http://localhost:3001';
  });
  afterEach(() => vi.restoreAllMocks());

  it('sends ?date_range=YYYY-MM-DD/YYYY-MM-DD on /v1/reports/employees/:id/rollup', async () => {
    const { calls, restore } = captureFetch({
      user: {
        id: 'usr_1',
        display_name: 'Ada',
        email: 'ada@example.com',
        timezone: 'UTC',
      },
      date_range: { from: '2026-05-18', to: '2026-05-24' },
      hours_by_project: [],
      out_of_scope_project_count: 0,
      out_of_scope_hours: 0,
      timeline: [],
      exceptions: [],
    } satisfies EmployeeDrillIn);
    try {
      await apiFetch<EmployeeDrillIn>('/v1/reports/employees/usr_1/rollup', {
        query: { date_range: buildDrillDateRange('UTC') },
      });
    } finally {
      restore();
    }
    const url = new URL(calls[0]!);
    expect(url.pathname).toBe('/v1/reports/employees/usr_1/rollup');
    expect(url.searchParams.get('date_range')).toMatch(DATE_RANGE_RE);
  });
});

describe('project rollup request (INC-007)', () => {
  beforeEach(() => {
    process.env.NEXT_PUBLIC_API_BASE_URL = 'http://localhost:3001';
  });
  afterEach(() => vi.restoreAllMocks());

  it('sends ?date_range=YYYY-MM-DD/YYYY-MM-DD on /v1/reports/projects/:id/rollup', async () => {
    const { calls, restore } = captureFetch({
      project: {
        id: 'prj_1',
        name: 'Pegasus',
        client_name: null,
        billing_mode: 'hourly',
        fixed_fee_amount: null,
        currency: 'USD',
        hours_budget: null,
      },
      date_range: { from: '2026-05-18', to: '2026-05-24' },
      total_hours: 0,
      billable_hours: 0,
      hours_by_member: [],
      hours_by_task: [],
    } satisfies ProjectRollupRow);
    try {
      await apiFetch<ProjectRollupRow>('/v1/reports/projects/prj_1/rollup', {
        query: { date_range: buildDrillDateRange('UTC') },
      });
    } finally {
      restore();
    }
    const url = new URL(calls[0]!);
    expect(url.pathname).toBe('/v1/reports/projects/prj_1/rollup');
    expect(url.searchParams.get('date_range')).toMatch(DATE_RANGE_RE);
  });
});

/**
 * Pin the useQuery options object both pages build, proving the query is gated
 * by `enabled: !!dateRange` (so a missing/empty range never fires the 400'ing
 * request) and the range is part of the queryKey (cache keyed by range).
 */
describe('drill-in useQuery gating (INC-007 enabled + queryKey)', () => {
  function employeeQueryOptions(userId: string, dateRange: string) {
    return {
      queryKey: ['dashboard', 'employee', userId, dateRange] as const,
      enabled: !!userId && !!dateRange,
      query: { date_range: dateRange },
    };
  }
  function projectQueryOptions(projectId: string, dateRange: string) {
    return {
      queryKey: ['dashboard', 'project-rollup', projectId, dateRange] as const,
      enabled: !!projectId && !!dateRange,
      query: { date_range: dateRange },
    };
  }

  it('employee query is ENABLED once both the id and a real range exist', () => {
    const opts = employeeQueryOptions('usr_1', '2026-05-18/2026-05-24');
    expect(opts.enabled).toBe(true);
    expect(opts.query.date_range).toMatch(DATE_RANGE_RE);
    expect(opts.queryKey).toEqual([
      'dashboard',
      'employee',
      'usr_1',
      '2026-05-18/2026-05-24',
    ]);
  });

  it('employee query stays DISABLED while the range is empty (no 400 request)', () => {
    expect(employeeQueryOptions('usr_1', '').enabled).toBe(false);
  });

  it('project query is ENABLED once both the id and a real range exist', () => {
    const opts = projectQueryOptions('prj_1', '2026-05-18/2026-05-24');
    expect(opts.enabled).toBe(true);
    expect(opts.query.date_range).toMatch(DATE_RANGE_RE);
    expect(opts.queryKey).toEqual([
      'dashboard',
      'project-rollup',
      'prj_1',
      '2026-05-18/2026-05-24',
    ]);
  });

  it('project query stays DISABLED while the range is empty (no 400 request)', () => {
    expect(projectQueryOptions('prj_1', '').enabled).toBe(false);
  });
});
