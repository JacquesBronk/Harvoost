import { Module } from '@nestjs/common';
import { LeaveController } from './leave.controller';

@Module({ controllers: [LeaveController] })
export class LeaveModule {}
