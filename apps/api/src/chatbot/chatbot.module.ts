import { Module } from '@nestjs/common';
import { ChatbotController } from './chatbot.controller';
import { LlmModule } from './llm.module';

@Module({
  imports: [LlmModule],
  controllers: [ChatbotController],
})
export class ChatbotModule {}
