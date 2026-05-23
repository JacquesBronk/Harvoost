import type { LLMProvider } from '@harvoost/shared';

// Generic Prisma-shaped surface for jobs — keeps Prisma a peer dep.
export interface JobsPrismaLike {
  $queryRawUnsafe<T = unknown>(sql: string, ...values: unknown[]): Promise<T>;
  $executeRawUnsafe(sql: string, ...values: unknown[]): Promise<number>;
}

export interface Mailer {
  send(input: { to: string; subject: string; html: string; text: string; from?: string }): Promise<{ messageId: string }>;
}

export interface JobsLogger {
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
}

export interface JobDeps {
  prisma: JobsPrismaLike;
  llm: LLMProvider;
  mailer: Mailer;
  logger: JobsLogger;
  // AUDIT_HASH_SECRET — required by audit-log-integrity HMAC recompute. Read
  // from env in the worker bootstrap and passed in via this surface so the
  // jobs package stays env-loader-agnostic.
  auditHashSecret?: string;
  // Optional pg-boss instance for jobs that enqueue follow-up work (e.g.,
  // export.large_xlsx). Optional so unit tests can omit it.
  boss?: { send(name: string, data?: unknown, options?: unknown): Promise<string | null> };
  // App Insights metric emitter — optional; jobs use logger.error with metric
  // tag when this is absent.
  metrics?: { emit(name: string, value?: number, tags?: Record<string, string>): void };
  // XLSX renderer — optional; injected by apps/api worker bootstrap so the
  // export.async_xlsx job can call into the same writer used by the sync path.
  xlsxRenderer?: {
    render(input: {
      filter: { date_from: string; date_to: string; user_ids: string[] | null; project_ids: string[] | null };
      actorUserId: string;
      jobId: string;
      canSeeFinancial: boolean;
    }): Promise<{ url: string; expiresAt: Date; rowCount: number }>;
  };
}

export interface JobDefinition {
  name: string;
  // pg-boss cron expression, or null for event-driven.
  cron?: string;
  // Trigger description for the catalogue.
  trigger: 'cron' | 'event' | 'startup';
  // Handler given a payload + deps; returns when complete.
  handler: (payload: unknown, deps: JobDeps) => Promise<void>;
  // One-line description of the failure mode.
  failureMode: string;
}
