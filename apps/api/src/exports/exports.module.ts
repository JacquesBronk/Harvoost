import { Module } from '@nestjs/common';
import { ExportsController } from './exports.controller';
import { XlsxWriterService } from './xlsx-writer.service';
import { ExportJobsService } from './export-jobs.service';

@Module({
  controllers: [ExportsController],
  providers: [XlsxWriterService, ExportJobsService],
  exports: [XlsxWriterService, ExportJobsService],
})
export class ExportsModule {}
