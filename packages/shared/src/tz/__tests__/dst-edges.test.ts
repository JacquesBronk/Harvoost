import { describe, it, expect } from 'vitest';
import { DateTime } from 'luxon';
import { nextDailyTriggerAt, nextWeekdayAt, weekRange, toUtc, localDateFor } from '../clock';

describe('DST edges — Europe/London spring-forward (2026-03-29 01:00 UTC = 02:00 BST jump)', () => {
  it('nextDailyTriggerAt at 08:00 local jumps DST forward', () => {
    // Right before spring-forward (DST starts at 2026-03-29 01:00 UTC = 02:00 BST).
    const beforeDst = DateTime.fromISO('2026-03-29T00:00:00Z', { zone: 'utc' });
    const trigger = nextDailyTriggerAt(8, 0, 'Europe/London', beforeDst);
    // 08:00 BST on 2026-03-29 = 07:00 UTC.
    expect(trigger.toISO()).toBe('2026-03-29T07:00:00.000Z');
  });

  it('weekRange in Europe/London containing spring-forward Sunday gives 7-day local span', () => {
    const aroundDst = DateTime.fromISO('2026-03-30T10:00:00Z', { zone: 'utc' });
    const r = weekRange(aroundDst, 'Europe/London', 1);
    // Local Mon 2026-03-30 00:00 BST — exactly 7 local days later.
    expect(r.startLocal.weekday).toBe(1);
    expect(r.endLocalExclusive.diff(r.startLocal, 'days').days).toBeCloseTo(7, 5);
  });
});

describe('DST edges — Europe/London fall-back (2026-10-25 02:00 BST → 01:00 GMT)', () => {
  it('nextDailyTriggerAt remains stable across fall-back', () => {
    const before = DateTime.fromISO('2026-10-25T00:30:00Z', { zone: 'utc' });
    const trigger = nextDailyTriggerAt(8, 0, 'Europe/London', before);
    // 08:00 GMT on 2026-10-25 = 08:00 UTC (DST ended at 01:00 UTC).
    expect(trigger.toISO()).toBe('2026-10-25T08:00:00.000Z');
  });

  it('localDateFor near midnight respects local TZ', () => {
    // 23:30 UTC on 2026-10-25 = 23:30 GMT = local date 2026-10-25 in London.
    expect(localDateFor(new Date('2026-10-25T23:30:00Z'), 'Europe/London')).toBe('2026-10-25');
    // Same instant in Asia/Tokyo (UTC+9) = 08:30 next day.
    expect(localDateFor(new Date('2026-10-25T23:30:00Z'), 'Asia/Tokyo')).toBe('2026-10-26');
  });
});

describe('DST edges — US/Eastern spring-forward (2026-03-08 07:00 UTC = 03:00 EDT jump)', () => {
  it('nextDailyTriggerAt at 08:00 local jumps DST forward', () => {
    const before = DateTime.fromISO('2026-03-08T05:00:00Z', { zone: 'utc' });
    const trigger = nextDailyTriggerAt(8, 0, 'America/New_York', before);
    // 08:00 EDT on 2026-03-08 = 12:00 UTC.
    expect(trigger.toISO()).toBe('2026-03-08T12:00:00.000Z');
  });
});

describe('US/Eastern fall-back (2026-11-01 06:00 UTC = 01:00 EST)', () => {
  it('nextDailyTriggerAt past the fall-back stays at intended local hour', () => {
    const before = DateTime.fromISO('2026-11-01T04:00:00Z', { zone: 'utc' });
    const trigger = nextDailyTriggerAt(8, 0, 'America/New_York', before);
    // 08:00 EST = 13:00 UTC.
    expect(trigger.toISO()).toBe('2026-11-01T13:00:00.000Z');
  });
});

describe('nextWeekdayAt — Monday 08:00 local in Africa/Johannesburg (no DST)', () => {
  it('returns Monday 08:00 SAST = 06:00 UTC', () => {
    const t = DateTime.fromISO('2026-05-22T10:00:00Z', { zone: 'utc' }); // Friday
    const r = nextWeekdayAt(1, 8, 0, 'Africa/Johannesburg', t);
    // Next Monday after a Friday = 2026-05-25 (Mon). 08:00 SAST = 06:00 UTC.
    expect(r.toISO()).toBe('2026-05-25T06:00:00.000Z');
  });

  it('rolls forward a week when we are already past Mon 08:00 local', () => {
    // Tuesday in JHB.
    const t = DateTime.fromISO('2026-05-26T10:00:00Z', { zone: 'utc' });
    const r = nextWeekdayAt(1, 8, 0, 'Africa/Johannesburg', t);
    expect(r.toISODate()).toBe('2026-06-01'); // next Monday
  });
});

describe('toUtc input validation', () => {
  it('accepts ISO with offset', () => {
    expect(toUtc('2026-05-22T09:30:00+02:00').toISO()).toBe('2026-05-22T07:30:00.000Z');
  });
  it('accepts ISO with Z', () => {
    expect(toUtc('2026-05-22T07:30:00Z').toISO()).toBe('2026-05-22T07:30:00.000Z');
  });
  it('rejects naive ISO', () => {
    expect(() => toUtc('2026-05-22T09:30:00')).toThrow(/missing explicit offset/i);
  });
  it('accepts Date and returns UTC', () => {
    expect(toUtc(new Date('2026-05-22T07:30:00Z')).toISO()).toBe('2026-05-22T07:30:00.000Z');
  });
});
