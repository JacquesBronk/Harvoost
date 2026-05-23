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

/** Return ISO start/end (UTC) for the ISO week containing `localDate` in `zone`. */
export function isoWeekRange(
  localDate: Date | string,
  zone: string = viewerTimeZone(),
): { startIso: string; endIso: string; weekLabel: string } {
  const dt =
    typeof localDate === 'string'
      ? DateTime.fromISO(localDate, { zone })
      : DateTime.fromJSDate(localDate, { zone });
  const start = dt.startOf('week'); // ISO Mon
  const end = start.plus({ days: 7 });
  return {
    startIso: start.toUTC().toISO() ?? '',
    endIso: end.toUTC().toISO() ?? '',
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
