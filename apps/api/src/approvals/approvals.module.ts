import { Module } from '@nestjs/common';
import { ApprovalsController } from './approvals.controller';
import { TimesheetPeriodsModule } from '../timesheet-periods/timesheet-periods.module';

@Module({
  imports: [TimesheetPeriodsModule],
  controllers: [ApprovalsController],
})
export class ApprovalsModule {}
