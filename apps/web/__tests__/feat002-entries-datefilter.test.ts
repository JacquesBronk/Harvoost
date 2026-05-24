import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DateTime, Settings } from 'luxon';
import { apiFetch } from '../src/lib/api-client.js';
import { isoWeekRange, currentIsoWeekRange } from '../src/lib/tz.js';
import type { OffsetPaginated, TimeEntry } from '../src/lib/api-types.js';

/**
 * FEAT-002 follow-on (GitHub #6) — /timesheets entry-list date filter.
 *
 * The /timesheets entry list filtered with `start_at_from` / `start_at_to`
 * (full ISO timestamps). The backend `GET /v1/time-entries` ListQuery honors
 * `date_from` / `date_to` as inclusive `YYYY-MM-DD` local dates (regex
 * `^\d{4}-\d{2}-\d{2}$`; openapi declares the same) and SILENTLY IGNORES the
 * `start_at_*` params. So the table actually listed ALL of the user's entries
 * across every week, and the Submit-week button (anchored on the newest draft)
 * could lock the WRONG week off a stale future-week draft.
 *
 * The fix sends `date_from` / `date_to` as the displayed week's Mon→Sun
 * `YYYY-MM-DD` bounds — the SAME bounds the period banner + week label derive
 * from (anchored to the page's `anchorIso` so Prev/Next keeps working). These
 * hermetic tests pin, at the `apiFetch` layer, the exact query the page issues:
 *   - it sends `date_from`/`date_to` in `YYYY-MM-DD` form matching the ISO week;
 *   - it does NOT send the ignored `start_at_from`/`start_at_to`;
 *   - the bounds agree with `currentIsoWeekRange` for the current week (so the
 *     list, the banner, and the Submit anchor all reference the same week).
 *
 * Node-env mocked-fetch convention from
 * apps/web/__tests__/inc004-reports-query.test.ts,
 * inc007-drillin-date-range.test.ts and feat002-list-envelope.test.ts.
 */

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

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
 * The exact entry-list request the /timesheets page issues, modelled from
 * apps/web/app/timesheets/page.tsx: `week = isoWeekRange(anchorIso, zone)` then
 * `query: { user_id, date_from: week.from, date_to: week.to, limit: 200 }`.
 */
function requestWeekEntries(
  anchorIso: string,
  zone: string,
  userId: string,
): Promise<OffsetPaginated<TimeEntry>> {
  const week = isoWeekRange(anchorIso, zone);
  return apiFetch<OffsetPaginated<TimeEntry>>('/v1/time-entries', {
    query: {
      user_id: userId,
      date_from: week.from,
      date_to: week.to,
      limit: 200,
    },
  });
}

function emptyPage(): OffsetPaginated<TimeEntry> {
  return { data: [], page: 1, page_size: 200, total_count: 0 };
}

beforeEach(() => {
  process.env.NEXT_PUBLIC_API_BASE_URL = 'http://localhost:3001';
});
afterEach(() => vi.restoreAllMocks());

describe('isoWeekRange date bounds (FEAT-002 entry-list filter)', () => {
  const realNow = Settings.now;
  afterEach(() => {
    Settings.now = realNow;
  });

  it('exposes inclusive Mon→Sun YYYY-MM-DD `from`/`to` for the anchored week', () => {
    // 2026-05-20 (Wed) is in the ISO week Mon 2026-05-18 → Sun 2026-05-24.
    const week = isoWeekRange('2026-05-20T12:00:00', 'UTC');
    expect(week.from).toBe('2026-05-18');
    expect(week.to).toBe('2026-05-24');
    expect(week.from).toMatch(DATE_RE);
    expect(week.to).toMatch(DATE_RE);
  });

  it('spans exactly 7 inclusive days (Mon..Sun)', () => {
    const week = isoWeekRange('2026-05-20T12:00:00', 'UTC');
    const days =
      DateTime.fromISO(week.to, { zone: 'UTC' }).diff(
        DateTime.fromISO(week.from, { zone: 'UTC' }),
        'days',
      ).days + 1;
    expect(days).toBe(7);
  });

  it('the anchored `from`/`to` agree with currentIsoWeekRange for "today"', () => {
    // 2026-05-24 (Sun) → ISO week Mon 2026-05-18 → Sun 2026-05-24.
    const fixed = DateTime.fromISO('2026-05-24T09:00:00', { zone: 'UTC' }).toMillis();
    Settings.now = () => fixed;
    const anchored = isoWeekRange(DateTime.now().setZone('UTC').toISO() ?? '', 'UTC');
    const current = currentIsoWeekRange('UTC');
    expect(anchored.from).toBe(current.from);
    expect(anchored.to).toBe(current.to);
  });
});

describe('/timesheets entry-list query params (FEAT-002 follow-on)', () => {
  it('GETs /v1/time-entries with date_from/date_to in YYYY-MM-DD for the ISO week', async () => {
    const { calls, restore } = captureFetch(emptyPage());
    try {
      await requestWeekEntries('2026-05-20T12:00:00', 'UTC', '3');
    } finally {
      restore();
    }
    const url = new URL(calls[0]!);
    expect(url.pathname).toBe('/v1/time-entries');

    const dateFrom = url.searchParams.get('date_from');
    const dateTo = url.searchParams.get('date_to');
    expect(dateFrom).toBe('2026-05-18');
    expect(dateTo).toBe('2026-05-24');
    expect(dateFrom).toMatch(DATE_RE);
    expect(dateTo).toMatch(DATE_RE);
  });

  it('does NOT send the silently-ignored start_at_from/start_at_to (regression guard)', async () => {
    const { calls, restore } = captureFetch(emptyPage());
    try {
      await requestWeekEntries('2026-05-20T12:00:00', 'UTC', '3');
    } finally {
      restore();
    }
    const url = new URL(calls[0]!);
    // The bug: these were sent (and ignored), so the list spanned every week.
    expect(url.searchParams.has('start_at_from')).toBe(false);
    expect(url.searchParams.has('start_at_to')).toBe(false);
  });

  it('keeps the non-drifted params (user_id scope + limit) on the request', async () => {
    const { calls, restore } = captureFetch(emptyPage());
    try {
      await requestWeekEntries('2026-05-20T12:00:00', 'UTC', '3');
    } finally {
      restore();
    }
    const url = new URL(calls[0]!);
    expect(url.searchParams.get('user_id')).toBe('3');
    expect(url.searchParams.get('limit')).toBe('200');
  });

  it('re-anchors the date window when navigating to a different week (Prev/Next)', async () => {
    const { calls, restore } = captureFetch(emptyPage());
    try {
      // Week of 2026-05-20, then the prior week (anchor shifted -7 days).
      await requestWeekEntries('2026-05-20T12:00:00', 'UTC', '3');
      await requestWeekEntries('2026-05-13T12:00:00', 'UTC', '3');
    } finally {
      restore();
    }
    const first = new URL(calls[0]!);
    const second = new URL(calls[1]!);
    expect(first.searchParams.get('date_from')).toBe('2026-05-18');
    expect(first.searchParams.get('date_to')).toBe('2026-05-24');
    expect(second.searchParams.get('date_from')).toBe('2026-05-11');
    expect(second.searchParams.get('date_to')).toBe('2026-05-17');
  });
});
