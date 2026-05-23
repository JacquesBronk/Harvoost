import { Inject, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { ENV_TOKEN } from '../../config/config.module';
import type { Env } from '../../config/env';

// Append-only audit log writer. The DB hash-chain trigger handles
// prev_row_hash / row_hash automatically, but the HMAC variant
// (20260522170000_audit_hmac) requires the per-session GUC
// `app.audit_hash_secret` to be SET LOCAL before INSERT — otherwise the
// trigger raises insufficient_privilege and the row is rejected.
//
// Used by every state-changing controller to satisfy the 7-year compliance
// retention promise in ARCHITECTURE.md.
//
// V2 fix (review attempt 2/2): the INSERT is wrapped in a Prisma transaction
// that issues `SET LOCAL app.audit_hash_secret` first. Failures are logged AND
// re-thrown — the audit log is load-bearing and silent loss is not acceptable
// once the HMAC migration is applied. Callers should treat audit failures as
// they would any other DB failure (i.e., let them bubble up; the global error
// filter maps them to 500).

export interface AuditRecordParams {
  actorId: string;
  action: string;            // e.g., 'user.role_grant', 'project.create', 'leave.approve'
  entityType: string;        // e.g., 'user', 'project', 'leave_request'
  entityId: string;
  before?: unknown;          // JSON-serialisable
  after?: unknown;
  reason?: string;
  metadata?: Record<string, unknown>;
}

@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(ENV_TOKEN) private readonly env: Env,
  ) {}

  async record(params: AuditRecordParams): Promise<void> {
    // Note: the audit_log schema is { actor_id, action, entity_type, entity_id,
    // before, after, reason, prev_row_hash, row_hash, created_at }. There is no
    // metadata column — caller-provided `metadata` is folded into `after` so it
    // remains in the hash-chain canonicalisation.
    const after =
      params.after !== undefined || params.metadata !== undefined
        ? {
            ...(typeof params.after === 'object' && params.after !== null
              ? params.after
              : params.after !== undefined
                ? { value: params.after }
                : {}),
            ...(params.metadata ? { _metadata: params.metadata } : {}),
          }
        : null;

    // Postgres SET LOCAL does not accept parameter binding for the value —
    // only literal strings. AUDIT_HASH_SECRET is server-side env (not user
    // input), so we escape single quotes defensively and inline.
    const safeSecret = this.env.AUDIT_HASH_SECRET.replace(/'/g, "''");

    try {
      // Use an interactive transaction so SET LOCAL scopes to the same
      // connection as the INSERT (SET LOCAL is rolled back on commit/abort).
      await this.prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(
          `SET LOCAL app.audit_hash_secret = '${safeSecret}'`,
        );
        await tx.$executeRawUnsafe(
          `INSERT INTO audit_log (actor_id, action, entity_type, entity_id, "before", "after", reason, created_at)
           VALUES ($1::bigint, $2, $3, $4, $5::jsonb, $6::jsonb, $7, NOW())`,
          params.actorId,
          params.action,
          params.entityType,
          params.entityId,
          params.before !== undefined ? JSON.stringify(params.before) : null,
          after !== null ? JSON.stringify(after) : null,
          params.reason ?? null,
        );
      });
    } catch (err) {
      // Log loudly — once the HMAC migration is applied, a failure here means
      // either the GUC isn't being applied, the AUDIT_HASH_SECRET is too short,
      // or the DB is unreachable. All three are operational issues that need
      // to surface to ops.
      this.logger.error('audit.record.failed', {
        action: params.action,
        entityType: params.entityType,
        entityId: params.entityId,
        actorId: params.actorId,
        err: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  }
}
