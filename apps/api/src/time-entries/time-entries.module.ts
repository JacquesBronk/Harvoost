import { Module } from '@nestjs/common';
import { TimeEntriesController } from './time-entries.controller';

@Module({
  controllers: [TimeEntriesController],
})
export class TimeEntriesModule {}
