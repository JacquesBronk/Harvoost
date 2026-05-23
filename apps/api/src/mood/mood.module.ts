import { Module } from '@nestjs/common';
import { MoodController } from './mood.controller';

@Module({ controllers: [MoodController] })
export class MoodModule {}
