import { DateTime } from 'luxon';
export interface WeekRange {
    startUtc: DateTime;
    endUtcExclusive: DateTime;
    startLocal: DateTime;
    endLocalExclusive: DateTime;
    zone: string;
}
export declare function toUtc(dt: Date | string, ianaTz?: string): DateTime;
export declare function nextDailyTriggerAt(localHour: number, localMinute: number, ianaTz: string, from?: DateTime): DateTime;
export declare function nextWeekdayAt(isoWeekday: 1 | 2 | 3 | 4 | 5 | 6 | 7, localHour: number, localMinute: number, ianaTz: string, from?: DateTime): DateTime;
export declare function weekRange(date: DateTime, ianaTz: string, weekStart?: 1 | 7): WeekRange;
export declare function localDateFor(instant: Date | DateTime, ianaTz: string): string;
//# sourceMappingURL=clock.d.ts.map