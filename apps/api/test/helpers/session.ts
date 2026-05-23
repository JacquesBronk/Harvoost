import { randomBytes } from 'node:crypto';

// File-level guard: NODE_ENV=test only. Importing this file in any other env
// raises immediately, preventing accidental production use.
if (process.env.NODE_ENV !== 'test') {
  throw new Error('mintTestSession is only allowed in NODE_ENV=test');
}

// Minimal prisma-shaped surface so tests can pass either a real PrismaClient
// or a thin mock that implements $executeRawUnsafe.
export interface MintTestSessionPrisma {
  $executeRawUnsafe(sql: string, ...values: unknown[]): Promise<unknown>;
}

// Inserts a row into `sessions` for `userId` and returns the bearer token the
// caller should pass as `Authorization: Bearer <token>` in test requests.
//
// Replaces the old `X-Mock-User-Id` shortcut that lived in BearerAuthGuard.
// This helper does NOT touch HTTP — it pre-populates a session row exactly the
// way `auth.controller.ts` would after a real OIDC callback.
//
// Optionally accepts a fixed token (useful for assertions); otherwise a fresh
// 32-byte base64url token is generated.
export async function mintTestSession(
  prisma: MintTestSessionPrisma,
  userId: string,
  opts: { token?: string; ttlMs?: number; kind?: 'web' | 'tray' } = {},
): Promise<{ token: string; expiresAt: Date }> {
  const token = opts.token ?? randomBytes(32).toString('base64url');
  const ttlMs = opts.ttlMs ?? 12 * 3600 * 1000;
  const kind = opts.kind ?? 'web';
  const expiresAt = new Date(Date.now() + ttlMs);

  await prisma.$executeRawUnsafe(
    `INSERT INTO sessions (user_id, kind, expires_at, refresh_token_hash, user_agent, ip)
     VALUES ($1::bigint, $2, $3::timestamptz, encode(digest($4::text, 'sha256'), 'hex'), $5, $6)`,
    userId,
    kind,
    expiresAt.toISOString(),
    token,
    'vitest-mintTestSession',
    '127.0.0.1',
  );

  return { token, expiresAt };
}
