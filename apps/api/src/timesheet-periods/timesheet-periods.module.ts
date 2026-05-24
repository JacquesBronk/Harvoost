import { Module } from '@nestjs/common';
import { TimesheetPeriodsController } from './timesheet-periods.controller';
import { PeriodService } from './period.service';

// FEAT-002 (issue #6). Owns the timesheet_periods read + unlock-week endpoints and exports the
// PeriodService (resolveWeek/assertPeriodWritable/recomputePeriod) so the time-entries and
// approvals controllers can enforce the lock + keep the period rollup consistent.
@Module({
  controllers: [TimesheetPeriodsController],
  providers: [PeriodService],
  exports: [PeriodService],
})
export class TimesheetPeriodsModule {}
