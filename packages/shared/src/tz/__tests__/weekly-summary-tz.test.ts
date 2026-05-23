import { describe, it, expect } from 'vitest';
import { DateTime } from 'luxon';
import { nextWeekdayAt, weekRange, localDateFor } from '../clock';

// Weekly summary delivery — Monday 08:00 local in recipient TZ (REQUIREMENTS F11.1).
// REQUIREMENTS § Risks: per-user TZ creates thundering-herd at common offsets;
// architecture mitigates via per-user enqueue + 10-min jitter.

describe('Weekly summary — multi-TZ Monday 08:00 local', () => {
  it('Africa/Johannesburg (UTC+2) Monday 08:00 → 06:00 UTC', () => {
    // Sunday 2026-05-24 (any time)
    const t = DateTime.fromISO('2026-05-24T12:00:00Z', { zone: 'utc' });
    const r = nextWeekdayAt(1, 8, 0, 'Africa/Johannesburg', t);
    expect(r.toISO()).toBe('2026-05-25T06:00:00.000Z');
  });

  it('Europe/London Monday 08:00 BST (summer) → 07:00 UTC', () => {
    // 2026-05-24 falls inside BST (DST active until late October).
    const t = DateTime.fromISO('2026-05-24T12:00:00Z', { zone: 'utc' });
    const r = nextWeekdayAt(1, 8, 0, 'Europe/London', t);
    expect(r.toISO()).toBe('2026-05-25T07:00:00.000Z');
  });

  it('America/New_York Monday 08:00 EDT → 12:00 UTC', () => {
    const t = DateTime.fromISO('2026-05-24T12:00:00Z', { zone: 'utc' });
    const r = nextWeekdayAt(1, 8, 0, 'America/New_York', t);
    expect(r.toISO()).toBe('2026-05-25T12:00:00.000Z');
  });

  it('Asia/Kolkata Monday 08:00 IST (UTC+5:30) → 02:30 UTC', () => {
    const t = DateTime.fromISO('2026-05-24T12:00:00Z', { zone: 'utc' });
    const r = nextWeekdayAt(1, 8, 0, 'Asia/Kolkata', t);
    expect(r.toISO()).toBe('2026-05-25T02:30:00.000Z');
  });

  it('the three default TZs produce three DIFFERENT UTC instants (no thundering herd at one instant)', () => {
    const t = DateTime.fromISO('2026-05-24T12:00:00Z', { zone: 'utc' });
    const sa = nextWeekdayAt(1, 8, 0, 'Africa/Johannesburg', t).toMillis();
    const london = nextWeekdayAt(1, 8, 0, 'Europe/London', t).toMillis();
    const ny = nextWeekdayAt(1, 8, 0, 'America/New_York', t).toMillis();
    expect(new Set([sa, london, ny]).size).toBe(3);
    // London is 1h after SA, NY is 6h after SA (in BST/EDT).
    expect(london - sa).toBe(3600 * 1000);
    expect(ny - sa).toBe(6 * 3600 * 1000);
  });
});

describe('Spring-forward day — schedule does not double-fire or skip', () => {
  it('Europe/London 08:00 local on spring-forward day resolves to a single, well-defined UTC instant', () => {
    // Spring forward in Europe/London: 2026-03-29 01:00 UTC = 02:00 BST jump to 03:00 BST.
    const beforeDst = DateTime.fromISO('2026-03-28T22:00:00Z', { zone: 'utc' });
    const trigger = nextWeekdayAt(7, 8, 0, 'Europe/London', beforeDst);
    // Sunday 2026-03-29 08:00 BST = 07:00 UTC.
    expect(trigger.toISO()).toBe('2026-03-29T07:00:00.000Z');
  });

  it('a second call right after still produces exactly one trigger (no duplicate)', () => {
    const before = DateTime.fromISO('2026-03-28T22:00:00Z', { zone: 'utc' });
    const t1 = nextWeekdayAt(7, 8, 0, 'Europe/London', before);
    // Re-query AT the trigger instant — must roll forward to next week.
    const t2 = nextWeekdayAt(7, 8, 0, 'Europe/London', t1);
    expect(t2.toMillis()).toBeGreaterThan(t1.toMillis());
    // Next Sunday 08:00 BST = 7 days later.
    expect(t2.diff(t1, 'days').days).toBeCloseTo(7, 5);
  });
});

describe('Time entry spanning midnight in local TZ — stored UTC, local_date derived', () => {
  it('entry 22:00–02:00 SAST: start_at and end_at have different local_dates', () => {
    // 22:00 SAST 2026-05-22 = 20:00 UTC same day.
    // 02:00 SAST 2026-05-23 = 00:00 UTC 2026-05-23.
    const startUtc = new Date('2026-05-22T20:00:00Z');
    const endUtc = new Date('2026-05-23T00:00:00Z');
    expect(localDateFor(startUtc, 'Africa/Johannesburg')).toBe('2026-05-22');
    expect(localDateFor(endUtc, 'Africa/Johannesburg')).toBe('2026-05-23');
  });

  it('the same instants yield the same local_dates in UTC viewer (sanity)', () => {
    const startUtc = new Date('2026-05-22T20:00:00Z');
    expect(localDateFor(startUtc, 'UTC')).toBe('2026-05-22');
  });
});

describe('weekRange — Mon..Sun in user TZ', () => {
  it('returns a 7-local-day range for Africa/Johannesburg', () => {
    const day = DateTime.fromISO('2026-05-22T12:00:00Z', { zone: 'utc' }); // Friday
    const r = weekRange(day, 'Africa/Johannesburg', 1);
    expect(r.startLocal.weekday).toBe(1); // Monday
    expect(r.endLocalExclusive.diff(r.startLocal, 'days').days).toBeCloseTo(7, 5);
    // The range start is Monday 2026-05-18 00:00 SAST = 2026-05-17 22:00 UTC.
    expect(r.startUtc.toISO()).toBe('2026-05-17T22:00:00.000Z');
  });

  it('crossing year boundary stays consistent', () => {
    const newYears = DateTime.fromISO('2026-01-01T05:00:00Z', { zone: 'utc' });
    const r = weekRange(newYears, 'UTC', 1);
    // ISO week of 2026-01-01 is the previous Monday (2025-12-29).
    expect(r.startLocal.toISODate()).toBe('2025-12-29');
  });
});
