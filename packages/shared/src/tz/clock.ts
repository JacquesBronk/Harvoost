import { DateTime } from 'luxon';

// All timestamps cross the API boundary as ISO-8601 with explicit offset.
// Server stores UTC; clients render in their own IANA TZ.

export interface WeekRange {
  startUtc: DateTime;
  endUtcExclusive: DateTime;
  startLocal: DateTime;
  endLocalExclusive: DateTime;
  zone: string;
}

// Convert a Date or ISO string to a Luxon DateTime in UTC, asserting the input had an offset.
export function toUtc(dt: Date | string, ianaTz?: string): DateTime {
  if (dt instanceof Date) {
    return DateTime.fromJSDate(dt, { zone: 'utc' });
  }
  // Reject naive ISO strings — the API_NOTES.md contract requires explicit offset.
  // (Heuristic: an ISO with offset ends with Z or +HH:MM / -HH:MM.)
  if (!/(?:Z|[+-]\d{2}:?\d{2})$/.test(dt)) {
    throw new RangeError(`ISO datetime missing explicit offset: ${dt}`);
  }
  const parsed = DateTime.fromISO(dt, { setZone: true });
  if (!parsed.isValid) {
    throw new RangeError(`Invalid ISO datetime: ${dt} — ${parsed.invalidExplanation ?? 'unknown'}`);
  }
  return ianaTz ? parsed.setZone(ianaTz).toUTC() : parsed.toUTC();
}

// nextDailyTriggerAt returns the next future UTC instant at (localHour:localMinute)
// in `ianaTz`. If `from` is already past today's trigger in local TZ, returns tomorrow.
//
// Used by the weekly-summary scheduler to compute the next Monday-08:00-local for each user.
export function nextDailyTriggerAt(
  localHour: number,
  localMinute: number,
  ianaTz: string,
  from: DateTime = DateTime.utc(),
): DateTime {
  if (!Number.isInteger(localHour) || localHour < 0 || localHour > 23) {
    throw new RangeError(`localHour out of range: ${localHour}`);
  }
  if (!Number.isInteger(localMinute) || localMinute < 0 || localMinute > 59) {
    throw new RangeError(`localMinute out of range: ${localMinute}`);
  }
  const fromInZone = from.setZone(ianaTz);
  if (!fromInZone.isValid) {
    throw new RangeError(`Invalid IANA TZ: ${ianaTz}`);
  }
  let candidate = fromInZone.set({ hour: localHour, minute: localMinute, second: 0, millisecond: 0 });
  if (candidate <= fromInZone) {
    candidate = candidate.plus({ days: 1 });
  }
  return candidate.toUTC();
}

// nextWeekdayAt returns the next future UTC instant at (localHour:localMinute) on the
// given ISO weekday (1=Mon..7=Sun) in `ianaTz`. Used for weekly summary (Monday 08:00 local).
export function nextWeekdayAt(
  isoWeekday: 1 | 2 | 3 | 4 | 5 | 6 | 7,
  localHour: number,
  localMinute: number,
  ianaTz: string,
  from: DateTime = DateTime.utc(),
): DateTime {
  const fromInZone = from.setZone(ianaTz);
  if (!fromInZone.isValid) {
    throw new RangeError(`Invalid IANA TZ: ${ianaTz}`);
  }
  // Jump to start-of-week (Mon), then add (isoWeekday - 1) days.
  let candidate = fromInZone.startOf('week').set({
    hour: localHour,
    minute: localMinute,
    second: 0,
    millisecond: 0,
  });
  candidate = candidate.plus({ days: isoWeekday - 1 });
  if (candidate <= fromInZone) {
    candidate = candidate.plus({ weeks: 1 });
  }
  return candidate.toUTC();
}

// weekRange — Mon..Sun (or Sun..Sat) range in user's local TZ around `date`, returned
// in both local and UTC form so callers can both query (UTC) and label (local).
// `weekStart=1` => Monday, `weekStart=7` => Sunday (ISO convention).
export function weekRange(date: DateTime, ianaTz: string, weekStart: 1 | 7 = 1): WeekRange {
  const local = date.setZone(ianaTz);
  if (!local.isValid) {
    throw new RangeError(`Invalid IANA TZ: ${ianaTz}`);
  }
  // Luxon's startOf('week') is locale-dependent; we force ISO (Mon-start) here.
  // For weekStart=7 (Sun), step back a day from Monday's start.
  const isoStart = local.startOf('week');
  const startLocal = weekStart === 1 ? isoStart : isoStart.minus({ days: 1 });
  const endLocalExclusive = startLocal.plus({ weeks: 1 });
  return {
    startUtc: startLocal.toUTC(),
    endUtcExclusive: endLocalExclusive.toUTC(),
    startLocal,
    endLocalExclusive,
    zone: ianaTz,
  };
}

// localDateFor returns the ISO date (YYYY-MM-DD) of `instant` interpreted in `ianaTz`.
// Used for `mood_entries.local_date` and `exceptions.local_date`.
export function localDateFor(instant: Date | DateTime, ianaTz: string): string {
  const dt = instant instanceof Date ? DateTime.fromJSDate(instant, { zone: 'utc' }) : instant;
  const iso = dt.setZone(ianaTz).toISODate();
  if (!iso) {
    throw new RangeError(`Cannot derive local_date for instant=${dt.toISO()} tz=${ianaTz}`);
  }
  return iso;
}
