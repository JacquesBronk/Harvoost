import { Global, Module } from '@nestjs/common';
import { IdempotencyService } from './idempotency/idempotency.service';

@Global()
@Module({
  providers: [IdempotencyService],
  exports: [IdempotencyService],
})
export class CommonModule {}
