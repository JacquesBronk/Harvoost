import { describe, it, expect, vi } from 'vitest';
import { AuthController } from '../../src/auth/auth.controller';
import type { Env } from '../../src/config/env';
import type { CurrentUserPayload } from '../../src/common/current-user.decorator';

// INC-002 regression guard: GET /v1/auth/me MUST include a non-empty
// `display_name`. The web /timesheets shell renders display_name directly, so
// the contract is `display_name: string` (never null/undefined). The bearer
// guard populates id/email/roles but NOT display_name, so the handler loads it
// from the users row and falls back to email when the column is null/blank.

function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
    NODE_ENV: 'test',
    PORT: 3001,
    WORKER_MODE: false,
    DATABASE_URL: 'postgresql://localhost/test',
    SESSION_SECRET: 'a'.repeat(32),
    AUDIT_HASH_SECRET: 'b'.repeat(32),
    BOOTSTRAP_ADMIN_EMAIL: 'admin@harvoost.local',
    CORS_ALLOWED_ORIGINS: 'http://localhost:3000',
    OIDC_ISSUER_URL: 'http://localhost:8080/realms/harvoost',
    OIDC_CLIENT_ID: 'harvoost-web',
    OIDC_REDIRECT_URI_WEB: 'http://localhost:3000/v1/auth/callback',
    OIDC_REDIRECT_URI_TRAY: 'harvoost://auth/callback',
    TEST_AUTH_BYPASS: false,
    LLM_PROVIDER: 'mock',
    LLM_MODEL_ID: 'mock-test',
    ACS_EMAIL_SENDER_ADDRESS: 'noreply@harvoost.local',
    BLOB_EXPORTS_CONTAINER: 'exports',
    WEB_ORIGIN: 'http://localhost:3000',
    ...overrides,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

// Prisma stub whose users SELECT returns the configured display_name.
function makePrismaStub(displayName: unknown) {
  return {
    $queryRawUnsafe: vi.fn(async (sql: string) => {
      if (/SELECT display_name FROM users/.test(sql)) {
        return [{ display_name: displayName }];
      }
      return [];
    }),
    $executeRawUnsafe: vi.fn(async () => 1),
  };
}

function makeController(prisma: ReturnType<typeof makePrismaStub>) {
  return new AuthController(
    makeEnv(),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    prisma as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    {} as any, // OidcService unused by /me
  );
}

const USER: CurrentUserPayload = {
  userId: '17',
  email: 'alice@harvoost.example.com',
  roles: ['manager'],
};

describe('AuthController.me — GET /v1/auth/me', () => {
  it('includes a non-empty display_name from the users row', async () => {
    const prisma = makePrismaStub('Alice Example');
    const ctrl = makeController(prisma);

    const out = await ctrl.me(USER);

    expect(out).toEqual({
      id: '17',
      email: 'alice@harvoost.example.com',
      display_name: 'Alice Example',
      roles: ['manager'],
    });
    expect(out.display_name).toBeTruthy();
    // Loaded from the users table, scoped to the authenticated user id.
    expect(prisma.$queryRawUnsafe).toHaveBeenCalledWith(
      expect.stringMatching(/SELECT display_name FROM users WHERE id = \$1::bigint/),
      '17',
    );
  });

  it('falls back to email when display_name is NULL (contract stays non-null)', async () => {
    const prisma = makePrismaStub(null);
    const ctrl = makeController(prisma);

    const out = await ctrl.me(USER);

    expect(out.display_name).toBe('alice@harvoost.example.com');
    expect(out.display_name).not.toBeNull();
  });

  it('falls back to email when display_name is blank/whitespace', async () => {
    const prisma = makePrismaStub('   ');
    const ctrl = makeController(prisma);

    const out = await ctrl.me(USER);

    expect(out.display_name).toBe('alice@harvoost.example.com');
  });

  it('falls back to email when the users row is missing entirely', async () => {
    const prisma = {
      $queryRawUnsafe: vi.fn(async () => []),
      $executeRawUnsafe: vi.fn(async () => 1),
    };
    const ctrl = makeController(prisma as ReturnType<typeof makePrismaStub>);

    const out = await ctrl.me(USER);

    expect(out.display_name).toBe('alice@harvoost.example.com');
  });
});
