// FEAT-002 (GitHub #6) — period / timesheet approval locking (Option F) helpers.
//
// Centralises the period read / submit-week / admin unlock-week API calls plus
// the PURE logic the /timesheets page and approvals page drive their UI from
// (locked-state derivation, submit-result summary, submit-button gating). The
// pure functions are exported standalone so the hermetic vitest suite can pin
// them in a node env without rendering the 'use client' pages.
//
// Shapes pinned by HANDOFF_backend.md (`>>> PINNED API SHAPES <<<`).

import { DateTime } from 'luxon';
import { apiFetch } from './api-client.js';
import { viewerTimeZone } from './tz.js';
import type {
  SubmitWeekResponse,
  TimesheetPeriod,
  TimesheetPeriodStatus,
  UnlockWeekResponse,
} from './api-types.js';

/** Period statuses in which the week is LOCKED for writes (mirrors the backend). */
const LOCKED_STATUSES: ReadonlySet<TimesheetPeriodStatus> = new Set([
  'submitted',
  'manager_approved',
  'final_approved',
]);

/** Matches the `YYYY-Www` ISO-week token the period endpoints take in the URL. */
export const ISO_WEEK_TOKEN_RE = /^\d{4}-W\d{2}$/;

/**
 * Build the `YYYY-Www` ISO-week token (e.g. "2026-W21") for the ISO week that
 * contains `anchorIso`, interpreted in `zone`. This is the token the period
 * endpoints expect in the URL path. Luxon's `weekYear`/`weekNumber` are the ISO
 * year/week, so a late-December date in ISO-week-1 correctly tokenizes to the
 * NEXT year. Returns `''` for an unparseable anchor so callers can gate.
 */
export function isoWeekToken(
  anchorIso: string | null | undefined,
  zone: string = viewerTimeZone(),
): string {
  if (!anchorIso) return '';
  const dt = DateTime.fromISO(anchorIso, { zone });
  if (!dt.isValid) return '';
  return `${dt.weekYear}-W${String(dt.weekNumber).padStart(2, '0')}`;
}

/** True when the period status means the week is locked for edits. */
export function isPeriodLocked(
  status: TimesheetPeriodStatus | null | undefined,
): boolean {
  return status != null && LOCKED_STATUSES.has(status);
}

/**
 * The submit-week button is enabled only when the week is OPEN (or unknown — we
 * fall back gracefully) AND there is at least one draft entry to submit. A
 * locked week (submitted / approved) disables it; a rejected week is writable
 * again so it follows the normal draft rule. `period` may be undefined when the
 * status call has not resolved or failed — in that case we do NOT block on
 * lock state and defer to `hasDraft` (resilience: never break the page).
 */
export function canSubmitWeek(
  period: Pick<TimesheetPeriod, 'status'> | null | undefined,
  hasDraft: boolean,
): boolean {
  if (!hasDraft) return false;
  if (period && isPeriodLocked(period.status)) return false;
  return true;
}

/** A short human label + tone for a period's lock banner, or null when open. */
export function periodLockBanner(
  period: Pick<TimesheetPeriod, 'status'> | null | undefined,
): { label: string; tone: 'info' | 'warning' | 'success' } | null {
  if (!period) return null;
  switch (period.status) {
    case 'submitted':
      return { label: 'Week submitted — locked', tone: 'info' };
    case 'manager_approved':
      return { label: 'Week manager-approved — locked', tone: 'warning' };
    case 'final_approved':
      return { label: 'Week final-approved — locked', tone: 'success' };
    default:
      // 'open' and 'rejected' are writable — no lock banner.
      return null;
  }
}

/**
 * Turn a submit-week response into user-facing feedback. The headline counts the
 * submitted entries; when entries were skipped we describe how many and why (a
 * running timer, or already-submitted entries). Pure so the toast copy is
 * testable without the page.
 */
export function summarizeSubmitResult(result: SubmitWeekResponse): {
  title: string;
  detail: string;
} {
  const n = result.submitted_ids.length;
  const skipped = result.skipped ?? [];
  const title =
    n === 0 ? 'Nothing submitted' : `Submitted ${n} ${n === 1 ? 'entry' : 'entries'}`;

  if (skipped.length === 0) {
    return {
      title,
      detail:
        n === 0
          ? 'There were no draft entries to submit in this week.'
          : 'Your timesheet is now awaiting manager approval.',
    };
  }

  const running = skipped.filter((s) => s.reason === 'running').length;
  const already = skipped.filter((s) => s.reason === 'already_submitted').length;
  const parts: string[] = [];
  if (running > 0) {
    parts.push(`${running} ${running === 1 ? 'entry is' : 'entries are'} still running`);
  }
  if (already > 0) {
    parts.push(`${already} ${already === 1 ? 'was' : 'were'} already submitted`);
  }
  // Any reason we don't recognize still gets counted so the total is honest.
  const accounted = running + already;
  if (accounted < skipped.length) {
    const other = skipped.length - accounted;
    parts.push(`${other} ${other === 1 ? 'entry' : 'entries'} skipped`);
  }

  const why = parts.join(', ');
  return {
    title,
    detail: `Skipped ${skipped.length} (${why}). Stop any running timer to include it.`,
  };
}

/**
 * GET /v1/timesheet-periods/{iso_week} (self). `isoWeek` is the `YYYY-Www` token.
 * Returns the persisted row or a synthesized open shell.
 */
export function fetchPeriod(isoWeek: string): Promise<TimesheetPeriod> {
  return apiFetch<TimesheetPeriod>(`/v1/timesheet-periods/${isoWeek}`);
}

/**
 * Submit an entire ISO week. Per API_NOTES.md (decision #4 + #10), per-week
 * submission is POST /v1/time-entries/{entry_id}/submit with scope=week against
 * ANY draft entry in the week; the server submits all draft entries in that ISO
 * week and returns `{ submitted_ids, skipped }`.
 */
export function submitWeek(anchorEntryId: string): Promise<SubmitWeekResponse> {
  return apiFetch<SubmitWeekResponse>(`/v1/time-entries/${anchorEntryId}/submit`, {
    method: 'POST',
    body: { scope: 'week' },
  });
}

/**
 * POST /v1/timesheet-periods/{user_id}/{iso_week}/unlock (admin only). Loops the
 * per-entry admin-unlock over every locked entry in the week → reopens it to
 * `open`. `reason` must be >= 20 chars (the backend rejects shorter with 400).
 */
export function unlockWeek(
  userId: string,
  isoWeek: string,
  reason: string,
): Promise<UnlockWeekResponse> {
  return apiFetch<UnlockWeekResponse>(
    `/v1/timesheet-periods/${userId}/${isoWeek}/unlock`,
    { method: 'POST', body: { reason } },
  );
}

/** Backend requires the unlock reason to be at least this many characters. */
export const UNLOCK_REASON_MIN = 20;

/** Client-side guard mirroring the backend's reason length rule. */
export function isValidUnlockReason(reason: string): boolean {
  return reason.trim().length >= UNLOCK_REASON_MIN;
}
