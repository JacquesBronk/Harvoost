import { Global, Module } from '@nestjs/common';
import { createLLMProvider, MockLLMProvider, type LLMProvider } from '@harvoost/shared';
import { ENV_TOKEN } from '../config/config.module';
import type { Env } from '../config/env';

export const LLM_PROVIDER_TOKEN = 'LLM_PROVIDER';

@Global()
@Module({
  providers: [
    {
      provide: LLM_PROVIDER_TOKEN,
      useFactory: (env: Env): LLMProvider => {
        if (env.NODE_ENV === 'test' || env.LLM_PROVIDER === 'mock') {
          return new MockLLMProvider();
        }
        return createLLMProvider({
          LLM_PROVIDER: env.LLM_PROVIDER,
          LLM_MODEL_ID: env.LLM_MODEL_ID,
          OPENAI_API_KEY: env.OPENAI_API_KEY,
          ANTHROPIC_API_KEY: env.ANTHROPIC_API_KEY,
          GOOGLE_GENERATIVE_AI_API_KEY: env.GOOGLE_GENERATIVE_AI_API_KEY,
          XAI_API_KEY: env.XAI_API_KEY,
          OLLAMA_BASE_URL: env.OLLAMA_BASE_URL,
        });
      },
      inject: [ENV_TOKEN],
    },
  ],
  exports: [LLM_PROVIDER_TOKEN],
})
export class LlmModule {}
