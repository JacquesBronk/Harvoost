import { Inject, Injectable, OnModuleDestroy, OnModuleInit, Logger } from '@nestjs/common';
import { ENV_TOKEN } from '../config/config.module';
import type { Env } from '../config/env';

// We import PrismaClient from @harvoost/db (the database-admin lane owns this package).
// The require is wrapped so type-checking can proceed in environments where the db
// package isn't yet built. At runtime the require resolves the real client.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyPrisma = any;

@Injectable()
export class PrismaService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PrismaService.name);
  // The actual concrete client is bound on init. We expose it as `any`-typed
  // because the schema is owned by another lane; we use raw SQL for the
  // load-bearing queries (RBAC, chatbot tools), and Prisma model APIs for CRUD.
  public client!: AnyPrisma;

  constructor(@Inject(ENV_TOKEN) private readonly env: Env) {}

  async onModuleInit(): Promise<void> {
    try {
      // Dynamic require — at runtime resolves to the workspace's @harvoost/db built artefact.
      // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
      const dbModule = require('@harvoost/db');
      const Ctor = dbModule.PrismaClient ?? dbModule.default?.PrismaClient;
      if (!Ctor) {
        throw new Error('@harvoost/db did not export PrismaClient');
      }
      this.client = new Ctor({
        datasources: { db: { url: this.env.DATABASE_URL } },
      });
      await this.client.$connect();
      this.logger.log('Prisma connected');
    } catch (err) {
      this.logger.warn(`Prisma init failed — running in DEGRADED mode: ${err instanceof Error ? err.message : String(err)}`);
      // We do not crash here so the API can still serve /v1/health with a degraded payload;
      // strictly DB-backed endpoints will throw at request time.
    }
  }

  async onModuleDestroy(): Promise<void> {
    if (this.client?.$disconnect) {
      await this.client.$disconnect();
    }
  }

  // Convenience: parameterized raw query passthrough.
  $queryRawUnsafe<T = unknown>(sql: string, ...values: unknown[]): Promise<T> {
    if (!this.client) throw new Error('Prisma client not initialized');
    return this.client.$queryRawUnsafe(sql, ...values);
  }

  $executeRawUnsafe(sql: string, ...values: unknown[]): Promise<number> {
    if (!this.client) throw new Error('Prisma client not initialized');
    return this.client.$executeRawUnsafe(sql, ...values);
  }

  // Interactive transaction passthrough. The callback receives a Prisma-shaped
  // tx that exposes the same $queryRawUnsafe + $executeRawUnsafe surface used
  // by the rest of the codebase. Used by the time-entries M1 fix and the
  // AuditService GUC wrapper.
  $transaction<T>(
    fn: (tx: {
      $queryRawUnsafe: <U = unknown>(sql: string, ...values: unknown[]) => Promise<U>;
      $executeRawUnsafe: (sql: string, ...values: unknown[]) => Promise<number>;
    }) => Promise<T>,
  ): Promise<T> {
    if (!this.client) throw new Error('Prisma client not initialized');
    return this.client.$transaction(fn);
  }
}
