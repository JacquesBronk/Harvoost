import { describe, it, expect, vi, afterEach } from 'vitest';
import { AuthController } from '../../src/auth/auth.controller';
import { OidcService } from '../../src/auth/oidc.service';
import type { Env } from '../../src/config/env';

// INC-008 (GitHub #11) — OIDC RP-initiated logout, provider-agnostic (ADR-0001).
//
// Option B (security advisory): we do NOT persist the id_token and add NO
// migration. The logout URL uses client_id + a SERVER-BUILT
// post_logout_redirect_uri (= WEB_ORIGIN + /login).
//
// Pinned contract:
//   POST /v1/auth/logout -> 200 { ok: true, logout_url: string | null }
//   logout_url = end_session_endpoint?client_id=...&post_logout_redirect_uri=...
//   logout_url = null when discovery has no end_session_endpoint.
//
// Covered here:
//   - OidcService.buildEndSessionUrl: builds the URL from the discovered
//     end_session_endpoint (works for ANY issuer — no hardcoded Keycloak path);
//     returns null (never throws) when end_session_endpoint is absent or
//     discovery is unreachable.
//   - AuthController.logout: revokes the local session + clears the cookie AND
//     returns a logout_url with client_id + the server-built
//     post_logout_redirect_uri; ignores all request input for the redirect
//     (CWE-601); graceful fallback to logout_url: null with local logout intact.

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
    OIDC_REDIRECT_URI_WEB: 'http://localhost:3000/auth/callback',
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

// Discovery doc factory. end_session_endpoint is optional so we can exercise the
// graceful-fallback path. Note the endpoint is deliberately NON-Keycloak in the
// provider-agnostic test to prove no hardcoded Keycloak path.
function discovery(opts: { issuer: string; endSession?: string }) {
  const doc: Record<string, string> = {
    issuer: opts.issuer,
    authorization_endpoint: `${opts.issuer}/authorize`,
    token_endpoint: `${opts.issuer}/token`,
    jwks_uri: `${opts.issuer}/jwks`,
  };
  if (opts.endSession) doc.end_session_endpoint = opts.endSession;
  return doc;
}

// ---- OidcService.buildEndSessionUrl -----------------------------------------

describe('OidcService.buildEndSessionUrl — provider-agnostic RP-initiated logout', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function mockDiscovery(doc: Record<string, string>) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => doc,
      text: async () => JSON.stringify(doc),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    })) as any;
  }

  it('builds end_session_endpoint?client_id=...&post_logout_redirect_uri=... from discovery', async () => {
    mockDiscovery(
      discovery({
        issuer: 'http://localhost:8080/realms/harvoost',
        endSession: 'http://localhost:8080/realms/harvoost/protocol/openid-connect/logout',
      }),
    );
    const svc = new OidcService(makeEnv());
    const url = await svc.buildEndSessionUrl({
      postLogoutRedirectUri: 'http://localhost:3000/login',
    });
    expect(url).not.toBeNull();
    const u = new URL(url!);
    expect(`${u.origin}${u.pathname}`).toBe(
      'http://localhost:8080/realms/harvoost/protocol/openid-connect/logout',
    );
    expect(u.searchParams.get('client_id')).toBe('harvoost-web');
    expect(u.searchParams.get('post_logout_redirect_uri')).toBe('http://localhost:3000/login');
    // Option B: NO id_token_hint is sent (we never persist the id_token).
    expect(u.searchParams.get('id_token_hint')).toBeNull();
  });

  it('is provider-agnostic: builds against a non-Keycloak (Entra-style) issuer with NO hardcoded path', async () => {
    const entraEndSession =
      'https://login.microsoftonline.com/tenant-abc/oauth2/v2.0/logout';
    mockDiscovery(
      discovery({
        issuer: 'https://login.microsoftonline.com/tenant-abc/v2.0',
        endSession: entraEndSession,
      }),
    );
    const svc = new OidcService(makeEnv({ OIDC_CLIENT_ID: 'entra-app-id' }));
    const url = await svc.buildEndSessionUrl({
      postLogoutRedirectUri: 'https://app.example.com/login',
    });
    expect(url).not.toBeNull();
    const u = new URL(url!);
    // The path comes entirely from the discovered endpoint — no Keycloak realm path.
    expect(`${u.origin}${u.pathname}`).toBe(entraEndSession);
    expect(url).not.toContain('/realms/');
    expect(url).not.toContain('openid-connect');
    expect(u.searchParams.get('client_id')).toBe('entra-app-id');
    expect(u.searchParams.get('post_logout_redirect_uri')).toBe('https://app.example.com/login');
  });

  it('returns null (no throw) when discovery has no end_session_endpoint', async () => {
    mockDiscovery(discovery({ issuer: 'http://localhost:8080/realms/harvoost' }));
    const svc = new OidcService(makeEnv());
    const url = await svc.buildEndSessionUrl({
      postLogoutRedirectUri: 'http://localhost:3000/login',
    });
    expect(url).toBeNull();
  });

  it('returns null (no throw) when discovery is unreachable', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    globalThis.fetch = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    }) as any;
    const svc = new OidcService(makeEnv());
    await expect(
      svc.buildEndSessionUrl({ postLogoutRedirectUri: 'http://localhost:3000/login' }),
    ).resolves.toBeNull();
  });

  it('appends logout_hint only when provided', async () => {
    mockDiscovery(
      discovery({
        issuer: 'http://localhost:8080/realms/harvoost',
        endSession: 'http://localhost:8080/realms/harvoost/protocol/openid-connect/logout',
      }),
    );
    const svc = new OidcService(makeEnv());
    const withHint = await svc.buildEndSessionUrl({
      postLogoutRedirectUri: 'http://localhost:3000/login',
      logoutHint: 'alice@example.com',
    });
    expect(new URL(withHint!).searchParams.get('logout_hint')).toBe('alice@example.com');

    const withoutHint = await svc.buildEndSessionUrl({
      postLogoutRedirectUri: 'http://localhost:3000/login',
    });
    expect(new URL(withoutHint!).searchParams.get('logout_hint')).toBeNull();
  });
});

// ---- AuthController.logout ---------------------------------------------------

function makePrismaStub() {
  const calls: Array<{ sql: string; values: unknown[] }> = [];
  return {
    calls,
    $queryRawUnsafe: vi.fn(async (sql: string, ...values: unknown[]) => {
      calls.push({ sql, values });
      return [];
    }),
    $executeRawUnsafe: vi.fn(async (sql: string, ...values: unknown[]) => {
      calls.push({ sql, values });
      return 1;
    }),
  };
}

function makeRes() {
  const cleared: Array<{ name: string; opts: Record<string, unknown> }> = [];
  return {
    cleared,
    cookie: vi.fn(),
    clearCookie: vi.fn((name: string, opts: Record<string, unknown>) => {
      cleared.push({ name, opts });
    }),
  };
}

// OidcService stub whose buildEndSessionUrl echoes back the post_logout_redirect_uri
// it was given, so we can assert the controller passes the SERVER-BUILT value.
function makeOidcStub(opts: { endSession?: string | null } = {}) {
  const endSession =
    opts.endSession === undefined
      ? 'http://localhost:8080/realms/harvoost/protocol/openid-connect/logout'
      : opts.endSession;
  return {
    buildEndSessionUrl: vi.fn(async (p: { postLogoutRedirectUri: string }) => {
      if (endSession === null) return null;
      const u = new URL(endSession);
      u.searchParams.set('client_id', 'harvoost-web');
      u.searchParams.set('post_logout_redirect_uri', p.postLogoutRedirectUri);
      return u.toString();
    }),
  };
}

function makeCtrl(
  prisma: ReturnType<typeof makePrismaStub>,
  oidc: ReturnType<typeof makeOidcStub>,
  env: Env = makeEnv(),
): AuthController {
  return new AuthController(
    env,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    prisma as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    oidc as any,
  );
}

describe('AuthController.logout — RP-initiated logout response (INC-008)', () => {
  it('revokes the local session, clears the cookie, and returns a logout_url with client_id + server-built post_logout_redirect_uri', async () => {
    const prisma = makePrismaStub();
    const oidc = makeOidcStub();
    const res = makeRes();
    const ctrl = makeCtrl(prisma, oidc);

    const out = await ctrl.logout(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { headers: { authorization: 'Bearer session-tok' } } as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      res as any,
    );

    // Local teardown happened.
    const revoke = prisma.calls.find((c) => /UPDATE sessions SET revoked_at/.test(c.sql));
    expect(revoke).toBeDefined();
    expect(revoke!.values[0]).toBe('session-tok');
    expect(res.cleared).toHaveLength(1);
    expect(res.cleared[0].name).toBe('harvoost_session');

    // Response shape + logout_url contents.
    expect(out.ok).toBe(true);
    expect(out.logout_url).not.toBeNull();
    const u = new URL(out.logout_url!);
    expect(u.searchParams.get('client_id')).toBe('harvoost-web');
    // post_logout_redirect_uri == WEB_ORIGIN + /login.
    expect(u.searchParams.get('post_logout_redirect_uri')).toBe('http://localhost:3000/login');

    // The controller built the redirect from trusted config — assert the value
    // handed to the service.
    expect(oidc.buildEndSessionUrl).toHaveBeenCalledWith({
      postLogoutRedirectUri: 'http://localhost:3000/login',
    });
  });

  it('post_logout_redirect_uri is derived ONLY from WEB_ORIGIN — ignores planted request input (CWE-601)', async () => {
    const prisma = makePrismaStub();
    const oidc = makeOidcStub();
    const res = makeRes();
    const ctrl = makeCtrl(prisma, oidc);

    // Plant attacker-controlled redirect targets across every request surface.
    const out = await ctrl.logout(
      {
        headers: {
          authorization: 'Bearer session-tok',
          referer: 'https://evil.example.com/phish',
          origin: 'https://evil.example.com',
        },
        query: { next: 'https://evil.example.com/login', returnTo: 'https://evil.example.com' },
        body: { next: 'https://evil.example.com', post_logout_redirect_uri: 'https://evil.example.com' },
        cookies: { harvoost_session: 'session-tok' },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      res as any,
    );

    const u = new URL(out.logout_url!);
    expect(u.searchParams.get('post_logout_redirect_uri')).toBe('http://localhost:3000/login');
    expect(out.logout_url).not.toContain('evil.example.com');
    expect(oidc.buildEndSessionUrl).toHaveBeenCalledWith({
      postLogoutRedirectUri: 'http://localhost:3000/login',
    });
  });

  it('uses the configured WEB_ORIGIN (prod) for the redirect — still no request input', async () => {
    const prisma = makePrismaStub();
    const oidc = makeOidcStub();
    const res = makeRes();
    const ctrl = makeCtrl(prisma, oidc, makeEnv({ WEB_ORIGIN: 'https://app.harvoost.com' }));

    const out = await ctrl.logout(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { headers: { authorization: 'Bearer session-tok' } } as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      res as any,
    );

    expect(new URL(out.logout_url!).searchParams.get('post_logout_redirect_uri')).toBe(
      'https://app.harvoost.com/login',
    );
  });

  it('graceful fallback: when no end_session_endpoint is discovered, returns { ok: true, logout_url: null } and still revokes locally', async () => {
    const prisma = makePrismaStub();
    const oidc = makeOidcStub({ endSession: null });
    const res = makeRes();
    const ctrl = makeCtrl(prisma, oidc);

    const out = await ctrl.logout(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { headers: { authorization: 'Bearer session-tok' } } as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      res as any,
    );

    expect(out).toEqual({ ok: true, logout_url: null });
    // Local teardown still happened.
    expect(prisma.calls.find((c) => /UPDATE sessions SET revoked_at/.test(c.sql))).toBeDefined();
    expect(res.cleared).toHaveLength(1);
  });

  it('no-token path: still clears the cookie and returns logout_url (no session UPDATE)', async () => {
    const prisma = makePrismaStub();
    const oidc = makeOidcStub();
    const res = makeRes();
    const ctrl = makeCtrl(prisma, oidc);

    const out = await ctrl.logout(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { headers: {} } as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      res as any,
    );

    expect(out.ok).toBe(true);
    expect(out).toHaveProperty('logout_url');
    expect(res.cleared).toHaveLength(1);
    expect(prisma.calls.find((c) => /UPDATE sessions/.test(c.sql))).toBeUndefined();
  });

  it('local teardown succeeds even if buildEndSessionUrl resolves null (IdP URL never blocks logout)', async () => {
    const prisma = makePrismaStub();
    const oidc = makeOidcStub({ endSession: null });
    const res = makeRes();
    const ctrl = makeCtrl(prisma, oidc);

    const out = await ctrl.logout(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { headers: { authorization: 'Bearer session-tok' } } as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      res as any,
    );

    // Cookie cleared + session revoked BEFORE we asked for the (null) logout URL.
    expect(res.cleared).toHaveLength(1);
    expect(prisma.calls.find((c) => /UPDATE sessions SET revoked_at/.test(c.sql))).toBeDefined();
    expect(out.logout_url).toBeNull();
  });
});
