import { Global, Module } from '@nestjs/common';
import { AuditService } from './audit.service';

// Global audit service — registered once, injectable into every state-changing controller.
@Global()
@Module({
  providers: [AuditService],
  exports: [AuditService],
})
export class AuditModule {}
