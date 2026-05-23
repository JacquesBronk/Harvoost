import { Module } from '@nestjs/common';
import { ExceptionsController } from './exceptions.controller';

@Module({ controllers: [ExceptionsController] })
export class ExceptionsModule {}
