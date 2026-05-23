import { describe, it, expect, vi } from 'vitest';
import { IdempotencyService } from '../../src/common/idempotency/idempotency.service';
import { IdempotencyConflictError } from '@harvoost/shared';

// We mock PrismaService with an in-memory store keyed on (user_id, idempotency_key).
function makeIdempotency(): { svc: IdempotencyService; store: Map<string, { body_hash: string; response: unknown }> } {
  const store = new Map<string, { body_hash: string; response: unknown }>();
  const prisma = {
    $queryRawUnsafe: vi.fn(async (sql: string, ...values: unknown[]) => {
      if (sql.includes('SELECT body_hash, response FROM idempotency_keys')) {
        const key = `${String(values[0])}:${String(values[1])}`;
        const v = store.get(key);
        return v ? [v] : [];
      }
      return [];
    }),
    $executeRawUnsafe: vi.fn(async (sql: string, ...values: unknown[]) => {
      if (sql.includes('CREATE TABLE')) return 0;
      if (sql.includes('INSERT INTO idempotency_keys')) {
        const key = `${String(values[0])}:${String(values[1])}`;
        if (!store.has(key)) {
          store.set(key, { body_hash: String(values[2]), response: JSON.parse(String(values[3])) });
        }
        return 1;
      }
      return 0;
    }),
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const svc = new IdempotencyService(prisma as any);
  return { svc, store };
}

describe('IdempotencyService', () => {
  it('returns null on first lookup', async () => {
    const { svc } = makeIdempotency();
    expect(await svc.lookup('user1', 'key1', { a: 1 })).toBeNull();
  });

  it('replays the same response for a same-body retry', async () => {
    const { svc } = makeIdempotency();
    await svc.store('user1', 'key1', { a: 1 }, { id: 42 });
    const v = await svc.lookup('user1', 'key1', { a: 1 });
    expect(v).toEqual({ id: 42 });
  });

  it('rejects same-key, different-body with IdempotencyConflictError', async () => {
    const { svc } = makeIdempotency();
    await svc.store('user1', 'key1', { a: 1 }, { id: 42 });
    await expect(svc.lookup('user1', 'key1', { a: 2 })).rejects.toBeInstanceOf(IdempotencyConflictError);
  });

  it('scopes by user — same key from different users is independent', async () => {
    const { svc } = makeIdempotency();
    await svc.store('user1', 'key1', { a: 1 }, { id: 42 });
    expect(await svc.lookup('user2', 'key1', { a: 9 })).toBeNull();
  });
});
