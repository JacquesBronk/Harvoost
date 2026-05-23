import { Module } from '@nestjs/common';
import { AuditLogController } from './audit-log.controller';

@Module({ controllers: [AuditLogController] })
export class AuditLogModule {}
