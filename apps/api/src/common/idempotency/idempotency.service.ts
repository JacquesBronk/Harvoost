import { Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { PrismaService } from '../../prisma/prisma.service';
import { IdempotencyConflictError } from '@harvoost/shared';

// Stored response shape — we record the hash of the request body so a same-key,
// different-body retry can be rejected (per API_NOTES.md § Idempotency).
export interface CachedResponse {
  bodyHash: string;
  response: unknown;
}

const TABLE_DDL = `
  CREATE TABLE IF NOT EXISTS idempotency_keys (
    id BIGSERIAL PRIMARY KEY,
    user_id BIGINT NOT NULL,
    idempotency_key TEXT NOT NULL,
    body_hash TEXT NOT NULL,
    response JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (user_id, idempotency_key)
  );
`;

@Injectable()
export class IdempotencyService {
  private ensureCalled = false;
  constructor(private readonly prisma: PrismaService) {}

  private async ensureTable(): Promise<void> {
    if (this.ensureCalled) return;
    // We assume the migration is owned by the db lane; we also create here defensively
    // so unit-test sqlite databases can survive without the migration. This is a no-op if the table exists.
    try {
      await this.prisma.$executeRawUnsafe(TABLE_DDL);
    } catch {
      // ignore — migration ownership lives in @harvoost/db.
    }
    this.ensureCalled = true;
  }

  hashBody(body: unknown): string {
    return createHash('sha256').update(JSON.stringify(body ?? null)).digest('hex');
  }

  // Returns the cached response if the key was previously seen with the same body, else null.
  // Throws IdempotencyConflictError if the key was seen with a different body.
  async lookup(userId: string, key: string, body: unknown): Promise<unknown | null> {
    await this.ensureTable();
    const bodyHash = this.hashBody(body);
    const rows = await this.prisma.$queryRawUnsafe<Array<{ body_hash: unknown; response: unknown }>>(
      `SELECT body_hash, response FROM idempotency_keys
       WHERE user_id = $1::bigint AND idempotency_key = $2 LIMIT 1`,
      userId,
      key,
    );
    if (rows.length === 0) return null;
    if (String(rows[0]!.body_hash) !== bodyHash) {
      throw new IdempotencyConflictError();
    }
    return rows[0]!.response;
  }

  async store(userId: string, key: string, body: unknown, response: unknown): Promise<void> {
    await this.ensureTable();
    const bodyHash = this.hashBody(body);
    await this.prisma.$executeRawUnsafe(
      `INSERT INTO idempotency_keys (user_id, idempotency_key, body_hash, response)
       VALUES ($1::bigint, $2, $3, $4::jsonb)
       ON CONFLICT (user_id, idempotency_key) DO NOTHING`,
      userId,
      key,
      bodyHash,
      JSON.stringify(response),
    );
  }
}
