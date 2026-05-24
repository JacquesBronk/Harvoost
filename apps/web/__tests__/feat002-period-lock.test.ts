import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DateTime, Settings } from 'luxon';
import { ApiError, apiFetch, describeError, friendlyErrorMessages } from '../src/lib/api-client.js';
import {
  ISO_WEEK_TOKEN_RE,
  UNLOCK_REASON_MIN,
  canSubmitWeek,
  fetchPeriod,
  isPeriodLocked,
  isValidUnlockReason,
  isoWeekToken,
  periodLockBanner,
  submitWeek,
  summarizeSubmitResult,
  unlockWeek,
} from '../src/lib/timesheet-periods.js';
import type {
  SubmitWeekResponse,
  TimesheetPeriod,
  TimesheetPeriodStatus,
} from '../src/lib/api-types.js';

/**
 * FEAT-002 (GitHub #6) — period / timesheet approval locking (Option F), frontend.
 *
 * The backend now: submits an ISO week (scope=week → { submitted_ids, skipped }),
 * returns 409 PERIOD_LOCKED on writes into a submitted/approved week, exposes a
 * self period-status read, and an admin unlock-week endpoint. These hermetic
 * tests pin the FE-side pieces the /timesheets page + approvals page drive their
 * UI from, using the node-env mocked-fetch + helper-extraction pattern from
 * apps/web/__tests__/inc004-rates-query.test.ts and inc007-drillin-date-range.test.ts:
 *   (a) PERIOD_LOCKED 409 surfaces a friendly message via describeError (no crash);
 *   (b) submit-week response { submitted_ids, skipped } is summarized correctly
 *       (success + skipped-reason feedback) and submitWeek hits the right URL/body;
 *   (c) week-status drives the Submit button gating + the locked banner.
 */

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

function captureFetch(
  status: number,
  body: unknown,
): { calls: Captured[]; restore: () => void } {
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
      return Promise.resolve(jsonResponse(status, body));
    });
  return { calls, restore: () => void (globalThis.fetch = original) };
}

/** Build a full TimesheetPeriod row of a given status (counts irrelevant here). */
function periodWith(status: TimesheetPeriodStatus): TimesheetPeriod {
  return {
    id: '7',
    user_id: '3',
    iso_year: 2026,
    iso_week: 21,
    week_start_date: '2026-05-18',
    status,
    entry_counts: {
      draft: 0,
      submitted: 0,
      manager_approved: 0,
      final_approved: 0,
      rejected: 0,
    },
  };
}

beforeEach(() => {
  process.env.NEXT_PUBLIC_API_BASE_URL = 'http://localhost:3001';
});
afterEach(() => vi.restoreAllMocks());

// ---------------------------------------------------------------------------
// (a) PERIOD_LOCKED 409 → friendly message (not a raw code, not a crash)
// ---------------------------------------------------------------------------
describe('PERIOD_LOCKED messaging (FEAT-002 task 1)', () => {
  it('registers a friendly message for PERIOD_LOCKED', () => {
    expect(friendlyErrorMessages.PERIOD_LOCKED).toBeDefined();
    expect(friendlyErrorMessages.PERIOD_LOCKED).toMatch(/locked/i);
    // Mirrors the dispatch copy: clear sentence, not a raw code.
    expect(friendlyErrorMessages.PERIOD_LOCKED).not.toMatch(/PERIOD_LOCKED/);
  });

  it('describeError maps a 409 PERIOD_LOCKED ApiError to the friendly sentence', () => {
    const err = new ApiError(409, {
      code: 'PERIOD_LOCKED',
      message: 'Cannot write into week 2026-W21 — it is submitted and locked.',
      details: { iso_year: 2026, iso_week: 21, status: 'submitted' },
    });
    const friendly = describeError(err);
    expect(friendly).toBe(friendlyErrorMessages.PERIOD_LOCKED);
    expect(friendly).toMatch(/locked/i);
    // The raw code never leaks to the user.
    expect(friendly).not.toContain('PERIOD_LOCKED');
  });

  it('a create into a locked week throws a typed ApiError describeError can render (no crash)', async () => {
    const { restore } = captureFetch(409, {
      code: 'PERIOD_LOCKED',
      message: 'Cannot write into week 2026-W21 — it is submitted and locked.',
      details: { iso_year: 2026, iso_week: 21, status: 'submitted' },
    });
    try {
      await expect(
        apiFetch('/v1/time-entries', {
          method: 'POST',
          body: { project_id: '1', start_at: 'x', end_at: 'y' },
        }),
      ).rejects.toMatchObject({ status: 409, code: 'PERIOD_LOCKED' });
    } finally {
      restore();
    }
  });

  it('describeError still falls back to the server message for an unknown code', () => {
    const err = new ApiError(409, { code: 'SOMETHING_NEW', message: 'A new server message.' });
    expect(describeError(err)).toBe('A new server message.');
  });
});

// ---------------------------------------------------------------------------
// (b) submit-week response { submitted_ids, skipped } handling
// ---------------------------------------------------------------------------
describe('submitWeek request shape (FEAT-002 task 2)', () => {
  it('POSTs scope=week to /v1/time-entries/{entry_id}/submit', async () => {
    const { calls, restore } = captureFetch(200, {
      submitted_ids: ['10', '11'],
      skipped: [],
    } satisfies SubmitWeekResponse);
    try {
      await submitWeek('42');
    } finally {
      restore();
    }
    const url = new URL(calls[0]!.url);
    expect(url.pathname).toBe('/v1/time-entries/42/submit');
    expect(calls[0]!.method).toBe('POST');
    expect(calls[0]!.body).toEqual({ scope: 'week' });
  });

  it('returns the { submitted_ids, skipped } envelope', async () => {
    const { restore } = captureFetch(200, {
      submitted_ids: ['10', '11'],
      skipped: [{ entry_id: '12', reason: 'running' }],
    } satisfies SubmitWeekResponse);
    try {
      const res = await submitWeek('10');
      expect(res.submitted_ids).toEqual(['10', '11']);
      expect(res.skipped).toEqual([{ entry_id: '12', reason: 'running' }]);
    } finally {
      restore();
    }
  });
});

describe('summarizeSubmitResult (FEAT-002 task 2 feedback)', () => {
  it('clean submit: success copy with the entry count', () => {
    const { title, detail } = summarizeSubmitResult({
      submitted_ids: ['10', '11', '12'],
      skipped: [],
    });
    expect(title).toBe('Submitted 3 entries');
    expect(detail).toMatch(/awaiting manager approval/i);
  });

  it('singular entry uses "entry" not "entries"', () => {
    expect(summarizeSubmitResult({ submitted_ids: ['10'], skipped: [] }).title).toBe(
      'Submitted 1 entry',
    );
  });

  it('skipped running timer: notes how many skipped + why', () => {
    const { title, detail } = summarizeSubmitResult({
      submitted_ids: ['10', '11'],
      skipped: [{ entry_id: '12', reason: 'running' }],
    });
    expect(title).toBe('Submitted 2 entries');
    expect(detail).toMatch(/skipped 1/i);
    expect(detail).toMatch(/running/i);
  });

  it('mixed skip reasons (running + already_submitted) are both described', () => {
    const { detail } = summarizeSubmitResult({
      submitted_ids: ['10'],
      skipped: [
        { entry_id: '12', reason: 'running' },
        { entry_id: '13', reason: 'already_submitted' },
        { entry_id: '14', reason: 'already_submitted' },
      ],
    });
    expect(detail).toMatch(/skipped 3/i);
    expect(detail).toMatch(/running/i);
    expect(detail).toMatch(/already submitted/i);
  });

  it('nothing submitted (all skipped): warns rather than implies success', () => {
    const { title, detail } = summarizeSubmitResult({
      submitted_ids: [],
      skipped: [{ entry_id: '12', reason: 'already_submitted' }],
    });
    expect(title).toBe('Nothing submitted');
    expect(detail).toMatch(/skipped 1/i);
  });

  it('counts an unrecognized skip reason in the total (honest count)', () => {
    const { detail } = summarizeSubmitResult({
      submitted_ids: ['10'],
      // Cast through unknown: a future reason the backend might add.
      skipped: [{ entry_id: '99', reason: 'mystery' as never }],
    });
    expect(detail).toMatch(/skipped 1/i);
  });
});

// ---------------------------------------------------------------------------
// (c) week-status drives the Submit button + the locked banner
// ---------------------------------------------------------------------------
describe('isPeriodLocked (FEAT-002 task 3)', () => {
  it('locked for submitted / manager_approved / final_approved', () => {
    expect(isPeriodLocked('submitted')).toBe(true);
    expect(isPeriodLocked('manager_approved')).toBe(true);
    expect(isPeriodLocked('final_approved')).toBe(true);
  });

  it('writable for open / rejected / unknown', () => {
    expect(isPeriodLocked('open')).toBe(false);
    expect(isPeriodLocked('rejected')).toBe(false);
    expect(isPeriodLocked(null)).toBe(false);
    expect(isPeriodLocked(undefined)).toBe(false);
  });
});

describe('canSubmitWeek (FEAT-002 task 2/3 button gating)', () => {
  it('enabled: open week with at least one draft', () => {
    expect(canSubmitWeek(periodWith('open'), true)).toBe(true);
  });

  it('disabled: no drafts to submit even when open', () => {
    expect(canSubmitWeek(periodWith('open'), false)).toBe(false);
  });

  it('disabled: a submitted (locked) week, regardless of drafts', () => {
    expect(canSubmitWeek(periodWith('submitted'), true)).toBe(false);
    expect(canSubmitWeek(periodWith('final_approved'), true)).toBe(false);
  });

  it('enabled: a rejected week is writable again (drafts can be resubmitted)', () => {
    expect(canSubmitWeek(periodWith('rejected'), true)).toBe(true);
  });

  it('resilient: undefined period (status call failed) defers to hasDraft', () => {
    // Falls back to current behavior — does NOT block on missing lock state.
    expect(canSubmitWeek(undefined, true)).toBe(true);
    expect(canSubmitWeek(undefined, false)).toBe(false);
  });
});

describe('periodLockBanner (FEAT-002 task 3 banner)', () => {
  it('no banner for open / rejected / missing', () => {
    expect(periodLockBanner(periodWith('open'))).toBeNull();
    expect(periodLockBanner(periodWith('rejected'))).toBeNull();
    expect(periodLockBanner(undefined)).toBeNull();
  });

  it('"submitted — locked" banner (info)', () => {
    const b = periodLockBanner(periodWith('submitted'));
    expect(b).not.toBeNull();
    expect(b!.label).toMatch(/submitted/i);
    expect(b!.label).toMatch(/locked/i);
    expect(b!.tone).toBe('info');
  });

  it('manager_approved → warning, final_approved → success, both locked', () => {
    expect(periodLockBanner(periodWith('manager_approved'))!.tone).toBe('warning');
    expect(periodLockBanner(periodWith('final_approved'))!.tone).toBe('success');
    expect(periodLockBanner(periodWith('manager_approved'))!.label).toMatch(/locked/i);
  });
});

describe('fetchPeriod request shape (FEAT-002 task 3)', () => {
  it('GETs /v1/timesheet-periods/{iso_week}', async () => {
    const { calls, restore } = captureFetch(200, periodWith('submitted'));
    try {
      await fetchPeriod('2026-W21');
    } finally {
      restore();
    }
    const url = new URL(calls[0]!.url);
    expect(url.pathname).toBe('/v1/timesheet-periods/2026-W21');
    expect(calls[0]!.method).toBe('GET');
  });

  it('tolerates the synthesized open shell (no id, null week_start_date)', async () => {
    const shell: TimesheetPeriod = {
      user_id: '3',
      iso_year: 2026,
      iso_week: 21,
      week_start_date: null,
      status: 'open',
      entry_counts: {
        draft: 0,
        submitted: 0,
        manager_approved: 0,
        final_approved: 0,
        rejected: 0,
      },
    };
    const { restore } = captureFetch(200, shell);
    try {
      const p = await fetchPeriod('2026-W21');
      expect(p.id).toBeUndefined();
      expect(p.week_start_date).toBeNull();
      expect(periodLockBanner(p)).toBeNull();
      expect(canSubmitWeek(p, true)).toBe(true);
    } finally {
      restore();
    }
  });
});

// ---------------------------------------------------------------------------
// isoWeekToken — the YYYY-Www the period URLs need (uses INC-007 tz helpers' zone)
// ---------------------------------------------------------------------------
describe('isoWeekToken (FEAT-002 ISO-week URL token)', () => {
  const realNow = Settings.now;
  afterEach(() => {
    Settings.now = realNow;
  });

  it('builds a YYYY-Www token for the anchor week', () => {
    // 2026-05-20 is in ISO week 21 of 2026.
    const anchor = DateTime.fromISO('2026-05-20T09:00:00', { zone: 'UTC' }).toISO()!;
    const token = isoWeekToken(anchor, 'UTC');
    expect(token).toBe('2026-W21');
    expect(token).toMatch(ISO_WEEK_TOKEN_RE);
  });

  it('zero-pads single-digit weeks', () => {
    const anchor = DateTime.fromISO('2026-01-05T09:00:00', { zone: 'UTC' }).toISO()!;
    expect(isoWeekToken(anchor, 'UTC')).toBe('2026-W02');
  });

  it('uses the ISO week-year for late-December dates that fall in week 1', () => {
    // 2025-12-31 is a Wednesday in ISO week 1 of 2026 — token must say 2026-W01.
    const anchor = DateTime.fromISO('2025-12-31T12:00:00', { zone: 'UTC' }).toISO()!;
    expect(isoWeekToken(anchor, 'UTC')).toBe('2026-W01');
  });

  it('returns "" for an empty/invalid anchor (caller gates the query)', () => {
    expect(isoWeekToken('', 'UTC')).toBe('');
    expect(isoWeekToken(null, 'UTC')).toBe('');
    expect(isoWeekToken('not-a-date', 'UTC')).toBe('');
  });
});

// ---------------------------------------------------------------------------
// (d) admin unlock-week affordance (FEAT-002 task 4)
// ---------------------------------------------------------------------------
describe('unlockWeek request shape (FEAT-002 task 4)', () => {
  it('POSTs { reason } to /v1/timesheet-periods/{user_id}/{iso_week}/unlock', async () => {
    const { calls, restore } = captureFetch(200, {
      unlocked_ids: ['20', '21'],
      user_id: '3',
      iso_year: 2026,
      iso_week: 21,
    });
    try {
      await unlockWeek('3', '2026-W21', 'Correcting a misallocated project entry');
    } finally {
      restore();
    }
    const url = new URL(calls[0]!.url);
    expect(url.pathname).toBe('/v1/timesheet-periods/3/2026-W21/unlock');
    expect(calls[0]!.method).toBe('POST');
    expect(calls[0]!.body).toEqual({ reason: 'Correcting a misallocated project entry' });
  });
});

describe('isValidUnlockReason (FEAT-002 task 4 reason guard)', () => {
  it(`requires at least ${UNLOCK_REASON_MIN} non-whitespace characters`, () => {
    expect(isValidUnlockReason('too short')).toBe(false);
    expect(isValidUnlockReason('   ' + 'x'.repeat(19))).toBe(false);
    expect(isValidUnlockReason('Correcting a misallocated project entry')).toBe(true);
    expect(isValidUnlockReason('x'.repeat(UNLOCK_REASON_MIN))).toBe(true);
  });
});

describe('ISO_WEEK_TOKEN_RE (approvals-row unlock gating)', () => {
  it('accepts a well-formed YYYY-Www token, rejects other week labels', () => {
    expect(ISO_WEEK_TOKEN_RE.test('2026-W21')).toBe(true);
    expect(ISO_WEEK_TOKEN_RE.test('2026-W2')).toBe(false);
    expect(ISO_WEEK_TOKEN_RE.test('Week 21')).toBe(false);
    expect(ISO_WEEK_TOKEN_RE.test('2026-05-18')).toBe(false);
  });
});
