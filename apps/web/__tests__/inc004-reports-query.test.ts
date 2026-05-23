import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DateTime, Settings } from 'luxon';
import { apiFetch } from '../src/lib/api-client.js';
import { currentMonthRange, dateRangeParam } from '../src/lib/tz.js';
import type {
  FinancialProjectRow,
  Paginated,
  ScopedList,
  TeamDashboardRow,
} from '../src/lib/api-types.js';

/**
 * INC-004 — frontend↔backend report endpoint drift (Rows 1 & 2).
 *
 * The pages used to send `start_at_from`/`start_at_to` ISO timestamps (dashboard)
 * and `group_by`/`limit` with no date range (financial), which the backend
 * rejected with 400 VALIDATION_FAILED. The contract is a single inclusive
 * local-date `date_range=YYYY-MM-DD/YYYY-MM-DD`, and the response envelope is
 * `{ items, ... }` with the financial rows renamed to `project_name`/`hours`.
 *
 * These tests pin the query construction (the date-range helpers + the actual
 * URL `apiFetch` builds) and the response-shape reads, matching the node-env
 * mocked-fetch convention in apps/web/__tests__.
 */

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

describe('dateRangeParam (INC-004 reports date_range)', () => {
  it('joins two inclusive local dates with a slash', () => {
    expect(dateRangeParam('2026-05-18', '2026-05-24')).toBe('2026-05-18/2026-05-24');
  });

  it('returns empty string if either bound is missing (keeps query disabled)', () => {
    expect(dateRangeParam('', '2026-05-24')).toBe('');
    expect(dateRangeParam('2026-05-18', '')).toBe('');
    expect(dateRangeParam('', '')).toBe('');
  });
});

describe('currentMonthRange (INC-004 financial default)', () => {
  const realNow = Settings.now;

  afterEach(() => {
    Settings.now = realNow;
  });

  it('defaults to first-of-month → today in the given zone', () => {
    // Pin "today" to 2026-05-23 (the run date) in UTC.
    const fixed = DateTime.fromISO('2026-05-23T10:30:00', { zone: 'UTC' }).toMillis();
    Settings.now = () => fixed;

    const { from, to } = currentMonthRange('UTC');
    expect(from).toBe('2026-05-01');
    expect(to).toBe('2026-05-23');
    expect(dateRangeParam(from, to)).toBe('2026-05-01/2026-05-23');
  });

  it('never returns a `to` before `from`', () => {
    const fixed = DateTime.fromISO('2026-05-01T00:05:00', { zone: 'UTC' }).toMillis();
    Settings.now = () => fixed;
    const { from, to } = currentMonthRange('UTC');
    expect(from).toBe('2026-05-01');
    expect(to >= from).toBe(true);
  });
});

describe('team-dashboard request (INC-004 Row 1)', () => {
  beforeEach(() => {
    process.env.NEXT_PUBLIC_API_BASE_URL = 'http://localhost:3001';
  });
  afterEach(() => vi.restoreAllMocks());

  it('sends ?date_range=YYYY-MM-DD/YYYY-MM-DD (not start_at_from/start_at_to)', async () => {
    const { calls, restore } = captureFetch({ items: [], scope_meta: {} });
    try {
      await apiFetch('/v1/reports/team-dashboard', {
        query: { date_range: dateRangeParam('2026-05-18', '2026-05-24') },
      });
    } finally {
      restore();
    }
    const url = new URL(calls[0]!);
    expect(url.pathname).toBe('/v1/reports/team-dashboard');
    expect(url.searchParams.get('date_range')).toBe('2026-05-18/2026-05-24');
    expect(url.searchParams.has('start_at_from')).toBe(false);
    expect(url.searchParams.has('start_at_to')).toBe(false);
  });

  it('reads the `items` envelope (not `data`)', async () => {
    const row: TeamDashboardRow = {
      user_id: 'usr_1',
      display_name: 'Alice',
      total_hours: 12.5,
      hours_by_project: [],
      missed_punch_count: 0,
      overtime_count: 0,
    };
    const { restore } = captureFetch({
      items: [row],
      scope_meta: { visible_users: 3, visible_projects: 2 },
    });
    try {
      const res = await apiFetch<ScopedList<TeamDashboardRow>>(
        '/v1/reports/team-dashboard',
        { query: { date_range: '2026-05-18/2026-05-24' } },
      );
      expect(res.items).toHaveLength(1);
      expect(res.items[0]!.total_hours).toBe(12.5);
      expect(res.scope_meta.visible_users).toBe(3);
    } finally {
      restore();
    }
  });
});

describe('profitability request (INC-004 Row 2)', () => {
  beforeEach(() => {
    process.env.NEXT_PUBLIC_API_BASE_URL = 'http://localhost:3001';
  });
  afterEach(() => vi.restoreAllMocks());

  it('sends ?date_range (defaulting to the current month)', async () => {
    const { calls, restore } = captureFetch({ items: [] });
    try {
      const { from, to } = currentMonthRange('UTC');
      await apiFetch('/v1/reports/profitability', {
        query: { date_range: dateRangeParam(from, to) },
      });
    } finally {
      restore();
    }
    const url = new URL(calls[0]!);
    expect(url.pathname).toBe('/v1/reports/profitability');
    const dr = url.searchParams.get('date_range');
    expect(dr).toMatch(/^\d{4}-\d{2}-\d{2}\/\d{4}-\d{2}-\d{2}$/);
  });

  it('reads `items` with the renamed `project_name` and `hours` fields', async () => {
    const row: FinancialProjectRow = {
      project_id: 'prj_1',
      project_name: 'Pegasus',
      client_name: 'Acme',
      billing_mode: 'fixed_fee',
      revenue: 10000,
      cost: 4000,
      margin: 6000,
      margin_pct: 0.6,
      hours: 80,
      billable_hours: 80,
      currency: 'ZAR',
    };
    const { restore } = captureFetch({ items: [row] });
    try {
      const res = await apiFetch<Paginated<FinancialProjectRow>>(
        '/v1/reports/profitability',
        { query: { date_range: '2026-05-01/2026-05-23' } },
      );
      expect(res.items).toHaveLength(1);
      expect(res.items[0]!.project_name).toBe('Pegasus');
      expect(res.items[0]!.hours).toBe(80);
    } finally {
      restore();
    }
  });
});
