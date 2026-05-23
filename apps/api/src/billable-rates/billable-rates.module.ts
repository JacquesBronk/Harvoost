import { Module } from '@nestjs/common';
import { BillableRatesController } from './billable-rates.controller';

@Module({ controllers: [BillableRatesController] })
export class BillableRatesModule {}
