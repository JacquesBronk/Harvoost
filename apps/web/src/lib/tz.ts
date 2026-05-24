// Timezone helpers built on Luxon.
//
// Rules from API_NOTES.md:
//   - Wire format: ISO 8601 with explicit offset (or Z).
//   - DB stores UTC. Client renders in viewer's local TZ by default.
//   - Schedule + mood operations interpret `date` in the SUBJECT user's TZ.

import { DateTime } from 'luxon';

export function viewerTimeZone(): string {
  if (typeof Intl !== 'undefined') {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (tz) return tz;
  }
  return 'UTC';
}

export function formatDateTime(
  iso: string | null | undefined,
  options: {
    zone?: string;
    format?: 'short' | 'medium' | 'long' | 'time' | 'date';
  } = {},
): string {
  if (!iso) return '—';
  const dt = DateTime.fromISO(iso, { setZone: true }).setZone(
    options.zone ?? viewerTimeZone(),
  );
  if (!dt.isValid) return iso;
  switch (options.format ?? 'short') {
    case 'time':
      return dt.toFormat('HH:mm');
    case 'date':
      return dt.toFormat('dd LLL yyyy');
    case 'medium':
      return dt.toFormat('dd LLL yyyy HH:mm');
    case 'long':
      return dt.toFormat('cccc, dd LLLL yyyy, HH:mm ZZZZ');
    case 'short':
    default:
      return dt.toFormat('dd LLL HH:mm');
  }
}

/** Format an hours-duration value to one decimal place. */
export function formatHours(hours: number | null | undefined): string {
  if (hours === null || hours === undefined) return '—';
  return `${hours.toFixed(1)}h`;
}

/**
 * Return the ISO week containing `localDate` in `zone`. Exposes both:
 *   - `startIso` / `endIso`: UTC ISO bounds (start inclusive, end exclusive
 *     = next Monday) for callers that filter on full timestamps; and
 *   - `from` / `to`: the inclusive local-date bounds (`YYYY-MM-DD`, Mon → Sun)
 *     that the `date_from` / `date_to` query params expect — same shape and
 *     Mon→Sun convention as `currentIsoWeekRange`, but ANCHORED to `localDate`
 *     so the /timesheets Prev/Next navigation stays correct.
 */
export function isoWeekRange(
  localDate: Date | string,
  zone: string = viewerTimeZone(),
): { startIso: string; endIso: string; from: string; to: string; weekLabel: string } {
  const dt =
    typeof localDate === 'string'
      ? DateTime.fromISO(localDate, { zone })
      : DateTime.fromJSDate(localDate, { zone });
  const start = dt.startOf('week'); // ISO Mon
  const end = start.plus({ days: 7 }); // next Mon (exclusive)
  const lastDay = start.plus({ days: 6 }); // Sun (inclusive)
  return {
    startIso: start.toUTC().toISO() ?? '',
    endIso: end.toUTC().toISO() ?? '',
    from: start.toISODate() ?? '',
    to: lastDay.toISODate() ?? '',
    weekLabel: `W${start.weekNumber} • ${start.toFormat('dd LLL')} – ${end
      .minus({ days: 1 })
      .toFormat('dd LLL yyyy')}`,
  };
}

/**
 * "In employee TZ" helper for manager views. Returns a badge label
 * when the entry's TZ differs from the viewer's.
 */
export function tzBadgeLabel(viewerZone: string, entryZone: string | null | undefined): string | null {
  if (!entryZone || entryZone === viewerZone) return null;
  return `in ${entryZone}`;
}

/** Returns the ISO local-date string (yyyy-MM-dd) for "today" in the given zone. */
export function todayLocalDate(zone: string = viewerTimeZone()): string {
  return DateTime.now().setZone(zone).toISODate() ?? '';
}

/**
 * INC-004: build the `date_range=YYYY-MM-DD/YYYY-MM-DD` query value the reports
 * endpoints (team-dashboard, profitability) read. Both bounds are inclusive
 * local dates already in `YYYY-MM-DD` form. Returns `''` if either bound is
 * empty so the caller can keep the query disabled.
 */
export function dateRangeParam(fromDate: string, toDate: string): string {
  if (!fromDate || !toDate) return '';
  return `${fromDate}/${toDate}`;
}

/**
 * INC-004: the current calendar month as an inclusive local-date range
 * (first-of-month → today). The profitability dashboard defaults to this when
 * the user has not picked an explicit range. `to` is clamped to today so we
 * never query into the future; if today is before the first of the month (it
 * never is) it still falls back to the month start.
 */
export function currentMonthRange(zone: string = viewerTimeZone()): {
  from: string;
  to: string;
} {
  const now = DateTime.now().setZone(zone);
  const from = now.startOf('month').toISODate() ?? '';
  const to = now.toISODate() ?? from;
  return { from, to: to < from ? from : to };
}

/**
 * INC-007: the current ISO week as an inclusive local-date range
 * (Monday → Sunday) in `zone`. The drill-in pages
 * (`/dashboard/employees/:id`, `/dashboard/projects/:id`) default to this so
 * the rollup endpoints get the required `date_range=YYYY-MM-DD/YYYY-MM-DD`
 * param. Mirrors the `this_week` branch the team dashboard
 * (apps/web/app/dashboard/page.tsx) builds inline: `now.startOf('week')` is the
 * ISO Monday and `+6 days` is the inclusive Sunday.
 */
export function currentIsoWeekRange(zone: string = viewerTimeZone()): {
  from: string;
  to: string;
} {
  const now = DateTime.now().setZone(zone);
  const start = now.startOf('week'); // ISO Mon
  const lastDay = start.plus({ days: 6 }); // Sun, inclusive
  return {
    from: start.toISODate() ?? '',
    to: lastDay.toISODate() ?? '',
  };
}
