import { Module } from '@nestjs/common';
import { TimeEntriesController } from './time-entries.controller';
import { TimesheetPeriodsModule } from '../timesheet-periods/timesheet-periods.module';

@Module({
  imports: [TimesheetPeriodsModule],
  controllers: [TimeEntriesController],
})
export class TimeEntriesModule {}
