import { Module } from '@nestjs/common';
import { CostRatesController } from './cost-rates.controller';

@Module({ controllers: [CostRatesController] })
export class CostRatesModule {}
