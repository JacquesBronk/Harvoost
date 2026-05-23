import { Controller, Get, Inject } from '@nestjs/common';
import { Public } from '../auth/public.decorator';
import { PrismaService } from '../prisma/prisma.service';
import { LLM_PROVIDER_TOKEN } from '../chatbot/llm.module';
import type { LLMProvider } from '@harvoost/shared';

@Controller('v1/health')
export class HealthController {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(LLM_PROVIDER_TOKEN) private readonly llm: LLMProvider,
  ) {}

  @Public()
  @Get()
  async health(): Promise<{
    status: 'ok' | 'degraded' | 'down';
    version: string;
    db: 'ok' | 'down';
    llm: { provider: string; model: string; enabled: boolean };
  }> {
    let db: 'ok' | 'down' = 'down';
    try {
      await this.prisma.$queryRawUnsafe(`SELECT 1`);
      db = 'ok';
    } catch {
      db = 'down';
    }
    const caps = this.llm.capabilities();
    const status = db === 'ok' ? 'ok' : 'degraded';
    return {
      status,
      version: process.env.npm_package_version ?? '0.1.0',
      db,
      llm: { provider: this.llm.provider, model: this.llm.model, enabled: caps.supportsTools },
    };
  }
}
