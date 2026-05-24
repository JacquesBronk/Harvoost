import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AuthController } from '../../src/auth/auth.controller';
import { BearerAuthGuard } from '../../src/auth/bearer-auth.guard';
import { UnauthorizedException } from '@nestjs/common';
import type { Env } from '../../src/config/env';

// HttpOnly session cookie issuance + bearer-or-cookie acceptance.
//
// Validates:
//   1. /v1/auth/oidc/callback sets a `harvoost_session` cookie via res.cookie()
//      with the HttpOnly + SameSite=Lax flags.
//   2. Cookie is marked Secure when NODE_ENV=production.
//   3. /v1/auth/logout clears the cookie via res.clearCookie('harvoost_session').
//   4. BearerAuthGuard accepts the cookie when Authorization header is absent.
//   5. BearerAuthGuard prefers the Authorization Bearer header over the cookie
//      when both are present (header wins — documented precedence).
//
// Note: the OIDC dance itself (discovery, JWKS, token exchange) is mocked at the
// OidcService level so this test exercises only the controller branches.

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

function makeOidcStub() {
  return {
    getDiscovery: vi.fn(async () => ({
      issuer: 'http://localhost:8080/realms/harvoost',
      authorization_endpoint: 'http://localhost:8080/realms/harvoost/protocol/openid-connect/auth',
      token_endpoint: 'http://localhost:8080/realms/harvoost/protocol/openid-connect/token',
      jwks_uri: 'http://localhost:8080/realms/harvoost/protocol/openid-connect/certs',
    })),
    getAuthorizationUrl: vi.fn(async () => 'http://localhost:8080/realms/harvoost/auth?stub=1'),
    exchangeCodeForToken: vi.fn(async () => ({ idToken: 'stub.id.token' })),
    validateIdToken: vi.fn(async () => ({
      sub: 'oidc-sub-42',
      email: 'alice@example.com',
      name: 'Alice',
    })),
    buildEndSessionUrl: vi.fn(
      async (p: { postLogoutRedirectUri: string }) =>
        `http://localhost:8080/realms/harvoost/protocol/openid-connect/logout?client_id=harvoost-web&post_logout_redirect_uri=${encodeURIComponent(
          p.postLogoutRedirectUri,
        )}`,
    ),
  };
}

function makePrismaStub() {
  return {
    $queryRawUnsafe: vi.fn(async (sql: string) => {
      if (sql.includes('INSERT INTO auth_pending')) {
        return [{ id: '11111111-1111-1111-1111-111111111111' }];
      }
      if (sql.includes('FROM auth_pending')) {
        return [
          {
            id: '11111111-1111-1111-1111-111111111111',
            state: 'state-from-pending',
            nonce: 'nonce-from-pending',
            code_verifier: 'verifier-from-pending',
            client_kind: 'web',
            redirect_uri: 'http://localhost:3000/v1/auth/callback',
            expires_at: new Date(Date.now() + 60_000).toISOString(),
          },
        ];
      }
      if (sql.includes('FROM users WHERE entra_object_id')) {
        return []; // not found → fall through to email lookup → new user
      }
      if (sql.includes('FROM users WHERE LOWER(email)')) {
        return []; // not found → new user
      }
      if (sql.includes('INSERT INTO users')) {
        return [{ id: 42 }];
      }
      if (sql.includes('FROM admin_email_allowlist')) {
        return [];
      }
      if (sql.includes('SELECT role FROM user_roles')) {
        return [{ role: 'employee' }];
      }
      if (sql.includes('FROM sessions')) {
        return [{ user_id: '42', expires_at: new Date(Date.now() + 3600_000).toISOString() }];
      }
      if (sql.includes('FROM users u')) {
        return [{ email: 'alice@example.com', role: 'employee' }];
      }
      return [];
    }),
    $executeRawUnsafe: vi.fn(async () => 1),
  };
}

function makeRes() {
  const cookies: Array<{ name: string; value: string; opts: Record<string, unknown> }> = [];
  const cleared: Array<{ name: string; opts: Record<string, unknown> }> = [];
  return {
    cookies,
    cleared,
    cookie: vi.fn((name: string, value: string, opts: Record<string, unknown>) => {
      cookies.push({ name, value, opts });
    }),
    clearCookie: vi.fn((name: string, opts: Record<string, unknown>) => {
      cleared.push({ name, opts });
    }),
  };
}

function makeReq(overrides: Partial<{ authorization: string; cookie: string }> = {}) {
  return {
    headers: {
      ...(overrides.authorization ? { authorization: overrides.authorization } : {}),
      'user-agent': 'vitest',
    },
    ip: '127.0.0.1',
    cookies: overrides.cookie ? { harvoost_session: overrides.cookie } : {},
  };
}

const CALLBACK_BODY = {
  code: 'auth-code-123',
  state: 'state-from-pending',
  opaque_state_id: '11111111-1111-1111-1111-111111111111',
};

describe('AuthController.oidcCallback — HttpOnly cookie issuance', () => {
  let prisma: ReturnType<typeof makePrismaStub>;
  let oidc: ReturnType<typeof makeOidcStub>;
  let res: ReturnType<typeof makeRes>;

  beforeEach(() => {
    prisma = makePrismaStub();
    oidc = makeOidcStub();
    res = makeRes();
  });

  it('sets harvoost_session cookie with HttpOnly + SameSite=Lax in non-production', async () => {
    const ctrl = new AuthController(
      makeEnv(),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      prisma as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      oidc as any,
    );
    await ctrl.oidcCallback(
      CALLBACK_BODY,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      makeReq() as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      res as any,
    );
    expect(res.cookies).toHaveLength(1);
    const [cookie] = res.cookies;
    expect(cookie.name).toBe('harvoost_session');
    expect(cookie.value).toMatch(/^[A-Za-z0-9_-]+$/); // base64url
    expect(cookie.opts.httpOnly).toBe(true);
    expect(cookie.opts.sameSite).toBe('lax');
    expect(cookie.opts.path).toBe('/');
    expect(cookie.opts.secure).toBe(false); // test mode, not prod
    expect(cookie.opts.maxAge).toBe(12 * 3600 * 1000);
  });

  it('sets Secure=true on the cookie when NODE_ENV=production', async () => {
    const env = makeEnv({ NODE_ENV: 'production' });
    const ctrl = new AuthController(
      env,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      prisma as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      oidc as any,
    );
    await ctrl.oidcCallback(
      CALLBACK_BODY,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      makeReq() as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      res as any,
    );
    expect(res.cookies).toHaveLength(1);
    expect(res.cookies[0].opts.secure).toBe(true);
  });

  it('logout clears the harvoost_session cookie via res.clearCookie', async () => {
    const ctrl = new AuthController(
      makeEnv(),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      prisma as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      oidc as any,
    );
    const ret = await ctrl.logout(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      makeReq({ cookie: 'opaque-token' }) as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      res as any,
    );
    expect(ret.ok).toBe(true);
    expect(ret).toHaveProperty('logout_url');
    expect(res.cleared).toHaveLength(1);
    expect(res.cleared[0].name).toBe('harvoost_session');
    expect(res.cleared[0].opts.path).toBe('/');
    // The cookie-token path must trigger a sessions UPDATE to revoke server-side.
    expect(prisma.$executeRawUnsafe).toHaveBeenCalledWith(
      expect.stringMatching(/UPDATE sessions SET revoked_at/),
      'opaque-token',
    );
  });

  it('logout with Bearer header also revokes (header takes precedence over cookie)', async () => {
    const ctrl = new AuthController(
      makeEnv(),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      prisma as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      oidc as any,
    );
    await ctrl.logout(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      makeReq({ authorization: 'Bearer header-token', cookie: 'cookie-token' }) as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      res as any,
    );
    expect(prisma.$executeRawUnsafe).toHaveBeenCalledWith(
      expect.stringMatching(/UPDATE sessions SET revoked_at/),
      'header-token',
    );
    expect(res.cleared[0].name).toBe('harvoost_session');
  });

  it('logout with no credentials still clears the cookie (best-effort)', async () => {
    const ctrl = new AuthController(
      makeEnv(),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      prisma as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      oidc as any,
    );
    await ctrl.logout(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      makeReq() as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      res as any,
    );
    expect(prisma.$executeRawUnsafe).not.toHaveBeenCalledWith(
      expect.stringMatching(/UPDATE sessions/),
      expect.anything(),
    );
    expect(res.cleared).toHaveLength(1);
  });
});

describe('AuthController.oidcCallback — error paths', () => {
  let prisma: ReturnType<typeof makePrismaStub>;
  let oidc: ReturnType<typeof makeOidcStub>;
  let res: ReturnType<typeof makeRes>;

  beforeEach(() => {
    prisma = makePrismaStub();
    oidc = makeOidcStub();
    res = makeRes();
  });

  it('rejects when auth_pending row is not found', async () => {
    prisma.$queryRawUnsafe = vi.fn(async (sql: string) => {
      if (sql.includes('FROM auth_pending')) return [];
      return [];
    });
    const ctrl = new AuthController(
      makeEnv(),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      prisma as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      oidc as any,
    );
    await expect(
      ctrl.oidcCallback(
        CALLBACK_BODY,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        makeReq() as any,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        res as any,
      ),
    ).rejects.toThrow(/OIDC pending-state not found/);
  });

  it('rejects when state does not match', async () => {
    const ctrl = new AuthController(
      makeEnv(),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      prisma as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      oidc as any,
    );
    await expect(
      ctrl.oidcCallback(
        { ...CALLBACK_BODY, state: 'WRONG-state' },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        makeReq() as any,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        res as any,
      ),
    ).rejects.toThrow(/OIDC state mismatch/);
  });
});

describe('BearerAuthGuard — cookie acceptance', () => {
  function makeGuard(env: Env, prisma: ReturnType<typeof makePrismaStub>) {
    const reflector = { getAllAndOverride: vi.fn(() => false) };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return new BearerAuthGuard(reflector as any, prisma as any, env);
  }

  function makeCtx(req: Record<string, unknown>) {
    return {
      switchToHttp: () => ({ getRequest: () => req }),
      getHandler: () => null,
      getClass: () => null,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;
  }

  it('accepts a request authenticated via harvoost_session cookie only', async () => {
    const env = makeEnv();
    const prisma = makePrismaStub();
    const guard = makeGuard(env, prisma);
    const req: Record<string, unknown> = {
      headers: {},
      cookies: { harvoost_session: 'cookie-token-abc' },
    };
    const ok = await guard.canActivate(makeCtx(req));
    expect(ok).toBe(true);
    expect(prisma.$queryRawUnsafe).toHaveBeenCalledWith(
      expect.stringMatching(/FROM sessions/),
      'cookie-token-abc',
    );
  });

  it('accepts Authorization: Bearer header when no cookie is set', async () => {
    const env = makeEnv();
    const prisma = makePrismaStub();
    const guard = makeGuard(env, prisma);
    const req: Record<string, unknown> = {
      headers: { authorization: 'Bearer header-only-token' },
      cookies: {},
    };
    const ok = await guard.canActivate(makeCtx(req));
    expect(ok).toBe(true);
    expect(prisma.$queryRawUnsafe).toHaveBeenCalledWith(
      expect.stringMatching(/FROM sessions/),
      'header-only-token',
    );
  });

  it('prefers Authorization header over cookie when both are present (header wins)', async () => {
    const env = makeEnv();
    const prisma = makePrismaStub();
    const guard = makeGuard(env, prisma);
    const req: Record<string, unknown> = {
      headers: { authorization: 'Bearer header-token' },
      cookies: { harvoost_session: 'cookie-token' },
    };
    await guard.canActivate(makeCtx(req));
    const sessionCall = prisma.$queryRawUnsafe.mock.calls.find((args) =>
      String(args[0]).includes('FROM sessions'),
    );
    expect(sessionCall![1]).toBe('header-token');
  });

  it('throws UnauthorizedException when neither cookie nor header is present', async () => {
    const env = makeEnv();
    const prisma = makePrismaStub();
    const guard = makeGuard(env, prisma);
    const req: Record<string, unknown> = { headers: {}, cookies: {} };
    await expect(guard.canActivate(makeCtx(req))).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('accepts X-Test-User-Id when TEST_AUTH_BYPASS=true and NODE_ENV=test', async () => {
    const env = makeEnv({ TEST_AUTH_BYPASS: true });
    const prisma = makePrismaStub();
    const guard = makeGuard(env, prisma);
    const req: Record<string, unknown> = {
      headers: { 'x-test-user-id': '42' },
      cookies: {},
    };
    const ok = await guard.canActivate(makeCtx(req));
    expect(ok).toBe(true);
    // Lookup goes by user id directly — no session table lookup.
    const userLookup = prisma.$queryRawUnsafe.mock.calls.find((args) =>
      String(args[0]).includes('FROM users u'),
    );
    expect(userLookup).toBeDefined();
    expect(userLookup![1]).toBe('42');
  });

  it('IGNORES X-Test-User-Id when TEST_AUTH_BYPASS=false (the default)', async () => {
    const env = makeEnv({ TEST_AUTH_BYPASS: false });
    const prisma = makePrismaStub();
    const guard = makeGuard(env, prisma);
    const req: Record<string, unknown> = {
      headers: { 'x-test-user-id': '42' },
      cookies: {},
    };
    await expect(guard.canActivate(makeCtx(req))).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });
});
