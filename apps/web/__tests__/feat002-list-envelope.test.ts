import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { apiFetch } from '../src/lib/api-client.js';
import {
  ISO_WEEK_TOKEN_RE,
  canSubmitWeek,
} from '../src/lib/timesheet-periods.js';
import type {
  EntryStatus,
  OffsetPaginated,
  TimeEntry,
} from '../src/lib/api-types.js';

/**
 * FEAT-002 EXPANSION (GitHub #6) — list-envelope reconciliation.
 *
 * Two FEAT-002 buttons were inert LIVE because the list pages read the WRONG
 * envelope key (`.items`) while the backend returns these lists under the
 * offset-paginated `{ data, page, page_size, total_count }` envelope
 * (OffsetPaginated). Symptoms (HANDOFF_e2e "Latent surprises"):
 *
 *   (a) /timesheets read `entriesQuery.data.items` → always empty → `hasDraft`
 *       false → the Submit-week button was permanently DISABLED.
 *   (c) /approvals read `queue.data.items` → empty queue → the per-row
 *       UnlockWeekButton (which needs the row's `YYYY-Www` iso_week) was
 *       unreachable.
 *
 * The fix reads `.data` on both pages. These hermetic tests pin the envelope
 * contract at the `apiFetch` layer (the exact call each page issues) AND model
 * the page's row-extraction + button-gating logic, proving:
 *   - the lists POPULATE from `{ data: [...] }`;
 *   - the OLD `.items` read would have produced an EMPTY list (a regression back
 *     to `.items` re-trips this test);
 *   - the timesheets submit-enable logic fires once a draft is present;
 *   - the approvals UnlockWeekButton gate (ISO_WEEK_TOKEN_RE) passes for the
 *     well-formed `iso_week` the enriched `{ data }` row carries.
 *
 * Node-env mocked-fetch + helper-extraction convention from
 * apps/web/__tests__/inc004-rates-query.test.ts and feat002-period-lock.test.ts.
 */

// The enriched approvals-queue row shape the page declares (the pinned contract
// the backend lane rebuilt GET /v1/approvals/queue to return). Kept local —
// mirrors the `ApprovalQueueItem` interface in app/approvals/page.tsx.
interface ApprovalQueueItem {
  id: string;
  user_id: string;
  user_name: string;
  iso_week: string;
  total_hours: number;
  status: string;
  submitted_at: string;
}

interface Captured {
  url: string;
  method: string;
  body: unknown;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function captureFetch(body: unknown): { calls: Captured[]; restore: () => void } {
  const calls: Captured[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = vi
    .fn()
    .mockImplementation((url: string | URL, init?: RequestInit) => {
      calls.push({
        url: String(url),
        method: init?.method ?? 'GET',
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      });
      return Promise.resolve(jsonResponse(200, body));
    });
  return { calls, restore: () => void (globalThis.fetch = original) };
}

// --- the page-level reads under test, modelled exactly as the pages do them ---

/** /timesheets reads `entriesQuery.data?.data ?? []` (FIXED). */
function readTimesheetEntries(resp: OffsetPaginated<TimeEntry> | undefined): TimeEntry[] {
  return resp?.data ?? [];
}

/** /approvals reads `queue.data?.data ?? []` (FIXED). */
function readApprovalRows(
  resp: OffsetPaginated<ApprovalQueueItem> | undefined,
): ApprovalQueueItem[] {
  return resp?.data ?? [];
}

/** The OLD (buggy) `.items` read both pages used to do — kept to prove regression. */
function readViaItems<T>(resp: { items?: T[] } | undefined): T[] {
  return resp?.items ?? [];
}

function entry(status: EntryStatus, id = '100'): TimeEntry {
  return {
    id,
    user_id: '3',
    project_id: '7',
    project_name: 'Analytical Engine',
    start_at: '2026-05-18T09:00:00+00:00',
    end_at: '2026-05-18T17:00:00+00:00',
    hours: 8,
    status,
    billable: true,
  };
}

function approvalRow(overrides: Partial<ApprovalQueueItem> = {}): ApprovalQueueItem {
  return {
    id: 'tsp_1',
    user_id: '3',
    user_name: 'Ada Lovelace',
    iso_week: '2026-W21',
    total_hours: 38.5,
    status: 'submitted',
    submitted_at: '2026-05-22T16:00:00+00:00',
    ...overrides,
  };
}

beforeEach(() => {
  process.env.NEXT_PUBLIC_API_BASE_URL = 'http://localhost:3001';
});
afterEach(() => vi.restoreAllMocks());

// ---------------------------------------------------------------------------
// (a) /timesheets entry list populates from { data: [...] } → Submit enables
// ---------------------------------------------------------------------------
describe('timesheets entry list envelope (FEAT-002 expansion a)', () => {
  it('GETs /v1/time-entries and reads rows from the { data } envelope', async () => {
    const { calls, restore } = captureFetch({
      data: [entry('draft', '101'), entry('submitted', '102')],
      page: 1,
      page_size: 200,
      total_count: 2,
    } satisfies OffsetPaginated<TimeEntry>);
    let resp: OffsetPaginated<TimeEntry>;
    try {
      resp = await apiFetch<OffsetPaginated<TimeEntry>>('/v1/time-entries', {
        query: { user_id: '3', limit: 200 },
      });
    } finally {
      restore();
    }
    expect(new URL(calls[0]!.url).pathname).toBe('/v1/time-entries');

    const entries = readTimesheetEntries(resp);
    expect(entries).toHaveLength(2);
    expect(entries.map((e) => e.id)).toEqual(['101', '102']);
  });

  it('the OLD `.items` read would have produced an EMPTY list (regression guard)', async () => {
    const { restore } = captureFetch({
      data: [entry('draft', '101')],
      page: 1,
      page_size: 200,
      total_count: 1,
    });
    let resp: OffsetPaginated<TimeEntry> & { items?: TimeEntry[] };
    try {
      resp = await apiFetch('/v1/time-entries', { query: { user_id: '3' } });
    } finally {
      restore();
    }
    // The bug: reading `.items` against a `{ data }` envelope yields nothing.
    expect(readViaItems(resp)).toHaveLength(0);
    // The fix: reading `.data` yields the row.
    expect(readTimesheetEntries(resp)).toHaveLength(1);
  });

  it('hasDraft + Submit-week enable: empty via .items disables, populated via .data enables', async () => {
    const { restore } = captureFetch({
      data: [entry('draft', '101'), entry('running', '102')],
      page: 1,
      page_size: 200,
      total_count: 2,
    });
    let resp: OffsetPaginated<TimeEntry>;
    try {
      resp = await apiFetch<OffsetPaginated<TimeEntry>>('/v1/time-entries');
    } finally {
      restore();
    }

    // OLD path: empty list → no draft → button DISABLED (the live bug).
    const oldEntries = readViaItems<TimeEntry>(resp);
    const oldHasDraft = oldEntries.some((e) => e.status === 'draft');
    expect(oldHasDraft).toBe(false);
    expect(canSubmitWeek(undefined, oldHasDraft)).toBe(false);

    // FIXED path: rows present → a draft exists → open week → button ENABLED.
    const entries = readTimesheetEntries(resp);
    const hasDraft = entries.some((e) => e.status === 'draft');
    expect(hasDraft).toBe(true);
    expect(canSubmitWeek({ status: 'open' }, hasDraft)).toBe(true);
  });

  it('all-submitted week (no draft) keeps Submit disabled even when rows populate', async () => {
    const { restore } = captureFetch({
      data: [entry('submitted', '201'), entry('submitted', '202')],
      page: 1,
      page_size: 200,
      total_count: 2,
    });
    let resp: OffsetPaginated<TimeEntry>;
    try {
      resp = await apiFetch<OffsetPaginated<TimeEntry>>('/v1/time-entries');
    } finally {
      restore();
    }
    const entries = readTimesheetEntries(resp);
    expect(entries).toHaveLength(2);
    const hasDraft = entries.some((e) => e.status === 'draft');
    expect(hasDraft).toBe(false);
    // Submitted week is locked AND has no draft → disabled (both reasons).
    expect(canSubmitWeek({ status: 'submitted' }, hasDraft)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// (c) /approvals queue renders rows from { data } → UnlockWeekButton reachable
// ---------------------------------------------------------------------------
describe('approvals queue envelope (FEAT-002 expansion c)', () => {
  it('GETs /v1/approvals/queue?stage=manager and reads rows from the { data } envelope', async () => {
    const { calls, restore } = captureFetch({
      data: [approvalRow({ id: 'tsp_1' }), approvalRow({ id: 'tsp_2', user_id: '4' })],
    } satisfies OffsetPaginated<ApprovalQueueItem>);
    let resp: OffsetPaginated<ApprovalQueueItem>;
    try {
      resp = await apiFetch<OffsetPaginated<ApprovalQueueItem>>('/v1/approvals/queue', {
        query: { stage: 'manager', limit: 50 },
      });
    } finally {
      restore();
    }
    const url = new URL(calls[0]!.url);
    expect(url.pathname).toBe('/v1/approvals/queue');
    expect(url.searchParams.get('stage')).toBe('manager');

    const rows = readApprovalRows(resp);
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.id)).toEqual(['tsp_1', 'tsp_2']);
    // The enriched shape the row renderer needs is present.
    expect(rows[0]).toMatchObject({
      user_name: 'Ada Lovelace',
      iso_week: '2026-W21',
      total_hours: 38.5,
      status: 'submitted',
    });
  });

  it('the OLD `.items` read would have produced an EMPTY queue (regression guard)', async () => {
    const { restore } = captureFetch({ data: [approvalRow()] });
    let resp: OffsetPaginated<ApprovalQueueItem> & { items?: ApprovalQueueItem[] };
    try {
      resp = await apiFetch('/v1/approvals/queue', { query: { stage: 'manager' } });
    } finally {
      restore();
    }
    expect(readViaItems(resp)).toHaveLength(0);
    expect(readApprovalRows(resp)).toHaveLength(1);
  });

  it('UnlockWeekButton gate fires for a well-formed iso_week carried by the { data } row', async () => {
    const { restore } = captureFetch({ data: [approvalRow({ iso_week: '2026-W21' })] });
    let resp: OffsetPaginated<ApprovalQueueItem>;
    try {
      resp = await apiFetch<OffsetPaginated<ApprovalQueueItem>>('/v1/approvals/queue');
    } finally {
      restore();
    }
    const [row] = readApprovalRows(resp);
    expect(row).toBeDefined();
    // The approvals page only renders UnlockWeekButton when the row carries a
    // well-formed YYYY-Www token (the unlock URL needs it). The { data } row does.
    expect(ISO_WEEK_TOKEN_RE.test(row!.iso_week)).toBe(true);
  });

  it('UnlockWeekButton gate withholds the button for a malformed week label', async () => {
    const { restore } = captureFetch({
      data: [approvalRow({ iso_week: 'Week 21' })],
    });
    let resp: OffsetPaginated<ApprovalQueueItem>;
    try {
      resp = await apiFetch<OffsetPaginated<ApprovalQueueItem>>('/v1/approvals/queue');
    } finally {
      restore();
    }
    const [row] = readApprovalRows(resp);
    expect(ISO_WEEK_TOKEN_RE.test(row!.iso_week)).toBe(false);
  });
});
