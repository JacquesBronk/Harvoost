import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AuthController } from '../../src/auth/auth.controller';
import { OIDCFailureError } from '@harvoost/shared';
import type { Env } from '../../src/config/env';

// Unit tests for AuthController.oidcCallback — the full OIDC callback path.
//
// We stub OidcService so no live IdP is contacted; the controller is exercised
// for:
//   - auth_pending lookup + state-mismatch + expired
//   - user upsert by sub (existing user vs new user)
//   - admin_email_allowlist + BOOTSTRAP_ADMIN_EMAIL role assignment
//   - HttpOnly Set-Cookie + auth_pending deletion
//   - roles list reflected in response

function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
    NODE_ENV: 'test',
    PORT: 3001,
    WORKER_MODE: false,
    DATABASE_URL: 'postgresql://localhost/test',
    SESSION_SECRET: 'a'.repeat(32),
    AUDIT_HASH_SECRET: 'b'.repeat(32),
    BOOTSTRAP_ADMIN_EMAIL: 'boss@harvoost.local',
    CORS_ALLOWED_ORIGINS: 'http://localhost:3000',
    OIDC_ISSUER_URL: 'http://kc/realms/harvoost',
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

interface FakePending {
  id: string;
  state: string;
  nonce: string;
  code_verifier: string;
  client_kind: 'web' | 'tray';
  redirect_uri: string;
  expires_at: string; // ISO
}

function makePrismaStub(opts: {
  pending?: FakePending | null;
  existingUserBySub?: string | null;
  existingUserByEmail?: string | null;
  allowlistMatch?: boolean;
  rolesOnExistingUser?: string[];
} = {}) {
  const calls: Array<{ sql: string; values: unknown[] }> = [];
  // Track inserted users so we can return roles for new users after the role insert.
  let insertedUserId: string | null = null;
  let insertedRole: string | null = null;
  return {
    calls,
    $queryRawUnsafe: vi.fn(async (sql: string, ...values: unknown[]) => {
      calls.push({ sql, values });
      if (/FROM auth_pending\s+WHERE id/.test(sql)) {
        return opts.pending === undefined ? [] : opts.pending ? [opts.pending] : [];
      }
      if (/FROM users WHERE entra_object_id/.test(sql)) {
        return opts.existingUserBySub ? [{ id: BigInt(opts.existingUserBySub) }] : [];
      }
      if (/FROM users WHERE LOWER\(email\)/.test(sql)) {
        return opts.existingUserByEmail ? [{ id: BigInt(opts.existingUserByEmail) }] : [];
      }
      if (/INSERT INTO users/.test(sql)) {
        insertedUserId = '5001';
        return [{ id: BigInt(insertedUserId) }];
      }
      if (/FROM admin_email_allowlist/.test(sql)) {
        return opts.allowlistMatch ? [{ c: 1 }] : [];
      }
      if (/SELECT role FROM user_roles/.test(sql)) {
        // If we just provisioned a new user, return the inserted role.
        if (insertedUserId && insertedRole) {
          return [{ role: insertedRole }];
        }
        return (opts.rolesOnExistingUser ?? []).map((r) => ({ role: r }));
      }
      return [];
    }),
    $executeRawUnsafe: vi.fn(async (sql: string, ...values: unknown[]) => {
      calls.push({ sql, values });
      if (/INSERT INTO user_roles/.test(sql)) {
        // values: [userId, role]
        insertedRole = String(values[1]);
      }
      return 1;
    }),
  };
}

function makeOidcStub(opts: { tokenIdToken?: string; validateClaims?: { sub: string; email?: string; name?: string }; validateThrows?: Error } = {}) {
  return {
    getAuthorizationUrl: vi.fn(async () => 'http://kc/authorize?...'),
    exchangeCodeForToken: vi.fn(async () => ({
      idToken: opts.tokenIdToken ?? 'eyJ.id.token',
      accessToken: 'a',
      refreshToken: 'r',
    })),
    validateIdToken: vi.fn(async () => {
      if (opts.validateThrows) throw opts.validateThrows;
      return opts.validateClaims ?? { sub: 'sub-1', email: 'alice@example.com', name: 'Alice' };
    }),
    buildEndSessionUrl: vi.fn(
      async (p: { postLogoutRedirectUri: string }) =>
        `http://kc/realms/harvoost/protocol/openid-connect/logout?client_id=harvoost-web&post_logout_redirect_uri=${encodeURIComponent(
          p.postLogoutRedirectUri,
        )}`,
    ),
  };
}

function makeResStub() {
  const cookies: Array<{ name: string; value: string; options: Record<string, unknown> }> = [];
  return {
    cookies,
    cookie: vi.fn((name: string, value: string, options: Record<string, unknown>) => {
      cookies.push({ name, value, options });
    }),
    clearCookie: vi.fn(),
  };
}

const VALID_BODY = {
  code: 'code-1',
  state: 'state-from-idp',
  opaque_state_id: '8a3a8b8d-cb22-4f9b-9b3a-aaaaaaaaaaaa',
};

const FUTURE_DATE = new Date(Date.now() + 60_000).toISOString();
const PAST_DATE = new Date(Date.now() - 60_000).toISOString();

describe('AuthController.oidcCallback — error paths', () => {
  it('throws OIDCFailureError when auth_pending row is missing', async () => {
    const prisma = makePrismaStub({ pending: null });
    const oidc = makeOidcStub();
    const ctrl = new AuthController(
      makeEnv(),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      prisma as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      oidc as any,
    );
    await expect(
      ctrl.oidcCallback(
        VALID_BODY,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        { headers: {}, ip: '1.1.1.1' } as any,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        makeResStub() as any,
      ),
    ).rejects.toBeInstanceOf(OIDCFailureError);
  });

  it('throws OIDCFailureError when auth_pending has expired', async () => {
    const prisma = makePrismaStub({
      pending: {
        id: VALID_BODY.opaque_state_id,
        state: 'state-from-idp',
        nonce: 'n',
        code_verifier: 'v',
        client_kind: 'web',
        redirect_uri: 'http://localhost:3000/v1/auth/callback',
        expires_at: PAST_DATE,
      },
    });
    const oidc = makeOidcStub();
    const ctrl = new AuthController(
      makeEnv(),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      prisma as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      oidc as any,
    );
    await expect(
      ctrl.oidcCallback(
        VALID_BODY,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        { headers: {}, ip: '1.1.1.1' } as any,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        makeResStub() as any,
      ),
    ).rejects.toThrow(/expired/i);
    // Pending row deletion attempted on expiry.
    expect(prisma.$executeRawUnsafe).toHaveBeenCalled();
  });

  it('throws OIDCFailureError when state does not match', async () => {
    const prisma = makePrismaStub({
      pending: {
        id: VALID_BODY.opaque_state_id,
        state: 'different-state',
        nonce: 'n',
        code_verifier: 'v',
        client_kind: 'web',
        redirect_uri: 'http://x/cb',
        expires_at: FUTURE_DATE,
      },
    });
    const oidc = makeOidcStub();
    const ctrl = new AuthController(
      makeEnv(),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      prisma as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      oidc as any,
    );
    await expect(
      ctrl.oidcCallback(
        VALID_BODY,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        { headers: {}, ip: '1.1.1.1' } as any,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        makeResStub() as any,
      ),
    ).rejects.toThrow(/state mismatch/i);
  });

  it('propagates id_token validation failure as OIDCFailureError', async () => {
    const prisma = makePrismaStub({
      pending: {
        id: VALID_BODY.opaque_state_id,
        state: 'state-from-idp',
        nonce: 'n',
        code_verifier: 'v',
        client_kind: 'web',
        redirect_uri: 'http://x/cb',
        expires_at: FUTURE_DATE,
      },
    });
    const oidc = makeOidcStub({ validateThrows: new OIDCFailureError('nonce mismatch') });
    const ctrl = new AuthController(
      makeEnv(),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      prisma as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      oidc as any,
    );
    await expect(
      ctrl.oidcCallback(
        VALID_BODY,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        { headers: {}, ip: '1.1.1.1' } as any,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        makeResStub() as any,
      ),
    ).rejects.toThrow(/nonce/);
  });

  it('throws when id_token has no email claim', async () => {
    const prisma = makePrismaStub({
      pending: {
        id: VALID_BODY.opaque_state_id,
        state: 'state-from-idp',
        nonce: 'n',
        code_verifier: 'v',
        client_kind: 'web',
        redirect_uri: 'http://x/cb',
        expires_at: FUTURE_DATE,
      },
    });
    const oidc = makeOidcStub({ validateClaims: { sub: 'sub-1' } });
    const ctrl = new AuthController(
      makeEnv(),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      prisma as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      oidc as any,
    );
    await expect(
      ctrl.oidcCallback(
        VALID_BODY,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        { headers: {}, ip: '1.1.1.1' } as any,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        makeResStub() as any,
      ),
    ).rejects.toThrow(/email claim/);
  });
});

describe('AuthController.oidcCallback — happy paths', () => {
  const pending: FakePending = {
    id: VALID_BODY.opaque_state_id,
    state: 'state-from-idp',
    nonce: 'n',
    code_verifier: 'v',
    client_kind: 'web',
    redirect_uri: 'http://localhost:3000/v1/auth/callback',
    expires_at: FUTURE_DATE,
  };

  it('upserts existing user by sub + sets HttpOnly Set-Cookie + returns user.id', async () => {
    const prisma = makePrismaStub({
      pending,
      existingUserBySub: '42',
      rolesOnExistingUser: ['employee'],
    });
    const oidc = makeOidcStub({ validateClaims: { sub: 'sub-1', email: 'alice@x.com', name: 'Alice' } });
    const res = makeResStub();
    const ctrl = new AuthController(
      makeEnv(),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      prisma as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      oidc as any,
    );
    const out = await ctrl.oidcCallback(
      VALID_BODY,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { headers: { 'user-agent': 'vitest' }, ip: '1.1.1.1' } as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      res as any,
    );
    expect(out.user.id).toBe('42');
    expect(out.user.email).toBe('alice@x.com');
    expect(out.user.roles).toEqual(['employee']);

    // Set-Cookie called with HttpOnly + SameSite=lax + Path=/.
    expect(res.cookies).toHaveLength(1);
    expect(res.cookies[0]!.name).toBe('harvoost_session');
    expect(res.cookies[0]!.options).toMatchObject({
      httpOnly: true,
      sameSite: 'lax',
      path: '/',
    });
    // secure is false in non-prod env.
    expect(res.cookies[0]!.options.secure).toBe(false);

    // auth_pending row deleted (single-use).
    expect(prisma.calls.some((c) => /DELETE FROM auth_pending/.test(c.sql))).toBe(true);
  });

  it('falls back to existing user by email when sub lookup misses (mock-OIDC legacy)', async () => {
    const prisma = makePrismaStub({
      pending,
      existingUserBySub: null,
      existingUserByEmail: '99',
      rolesOnExistingUser: ['manager'],
    });
    const oidc = makeOidcStub({ validateClaims: { sub: 'real-sub', email: 'legacy@x.com', name: 'Legacy' } });
    const res = makeResStub();
    const ctrl = new AuthController(
      makeEnv(),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      prisma as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      oidc as any,
    );
    const out = await ctrl.oidcCallback(
      VALID_BODY,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { headers: {}, ip: '1.1.1.1' } as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      res as any,
    );
    expect(out.user.id).toBe('99');
    // Legacy user's entra_object_id was rewritten to the canonical sub.
    const updateCall = prisma.calls.find((c) => /UPDATE users SET entra_object_id/.test(c.sql));
    expect(updateCall).toBeDefined();
    expect(updateCall!.values[0]).toBe('real-sub');
  });

  it('NEW user: admin role assigned when email is in admin_email_allowlist', async () => {
    const prisma = makePrismaStub({
      pending,
      existingUserBySub: null,
      existingUserByEmail: null,
      allowlistMatch: true,
    });
    const oidc = makeOidcStub({ validateClaims: { sub: 'new-sub', email: 'special@x.com', name: 'Special' } });
    const res = makeResStub();
    const ctrl = new AuthController(
      makeEnv(),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      prisma as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      oidc as any,
    );
    const out = await ctrl.oidcCallback(
      VALID_BODY,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { headers: {}, ip: '1.1.1.1' } as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      res as any,
    );
    expect(out.user.roles).toEqual(['admin']);
    const roleInsert = prisma.calls.find((c) => /INSERT INTO user_roles/.test(c.sql));
    expect(roleInsert).toBeDefined();
    expect(roleInsert!.values[1]).toBe('admin');
  });

  it('NEW user: admin role assigned when email matches BOOTSTRAP_ADMIN_EMAIL', async () => {
    const prisma = makePrismaStub({
      pending,
      existingUserBySub: null,
      existingUserByEmail: null,
      allowlistMatch: false,
    });
    const oidc = makeOidcStub({
      validateClaims: { sub: 'new-sub', email: 'boss@harvoost.local', name: 'Boss' },
    });
    const res = makeResStub();
    const ctrl = new AuthController(
      makeEnv(), // BOOTSTRAP_ADMIN_EMAIL = boss@harvoost.local
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      prisma as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      oidc as any,
    );
    const out = await ctrl.oidcCallback(
      VALID_BODY,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { headers: {}, ip: '1.1.1.1' } as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      res as any,
    );
    expect(out.user.roles).toEqual(['admin']);
  });

  it('NEW user: employee role assigned when neither allowlist nor bootstrap match', async () => {
    const prisma = makePrismaStub({
      pending,
      existingUserBySub: null,
      existingUserByEmail: null,
      allowlistMatch: false,
    });
    const oidc = makeOidcStub({
      validateClaims: { sub: 'new-sub', email: 'random@x.com', name: 'Rando' },
    });
    const res = makeResStub();
    const ctrl = new AuthController(
      makeEnv(),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      prisma as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      oidc as any,
    );
    const out = await ctrl.oidcCallback(
      VALID_BODY,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { headers: {}, ip: '1.1.1.1' } as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      res as any,
    );
    expect(out.user.roles).toEqual(['employee']);
  });

  it('Secure cookie flag is true in production env', async () => {
    const prisma = makePrismaStub({
      pending,
      existingUserBySub: '42',
      rolesOnExistingUser: ['employee'],
    });
    const oidc = makeOidcStub({ validateClaims: { sub: 's', email: 'a@x.com' } });
    const res = makeResStub();
    const ctrl = new AuthController(
      makeEnv({ NODE_ENV: 'production' }),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      prisma as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      oidc as any,
    );
    await ctrl.oidcCallback(
      VALID_BODY,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { headers: {}, ip: '1.1.1.1' } as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      res as any,
    );
    expect(res.cookies[0]!.options.secure).toBe(true);
  });

  it('session row is inserted with kind from auth_pending.client_kind', async () => {
    const prisma = makePrismaStub({
      pending: { ...pending, client_kind: 'tray' },
      existingUserBySub: '42',
      rolesOnExistingUser: [],
    });
    const oidc = makeOidcStub({ validateClaims: { sub: 's', email: 'a@x.com' } });
    const ctrl = new AuthController(
      makeEnv(),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      prisma as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      oidc as any,
    );
    await ctrl.oidcCallback(
      VALID_BODY,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { headers: {}, ip: '1.1.1.1' } as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      makeResStub() as any,
    );
    const insertSession = prisma.calls.find((c) => /INSERT INTO sessions/.test(c.sql));
    expect(insertSession).toBeDefined();
    // values: [userId, kind, expiresAt, sessionToken, ua, ip]
    expect(insertSession!.values[1]).toBe('tray');
  });
});

describe('AuthController.logout', () => {
  it('clears the session cookie even when no token is presented', async () => {
    const prisma = makePrismaStub();
    const oidc = makeOidcStub();
    const res = makeResStub();
    const ctrl = new AuthController(
      makeEnv(),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      prisma as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      oidc as any,
    );
    const out = await ctrl.logout(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { headers: {} } as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      res as any,
    );
    expect(out.ok).toBe(true);
    expect(out).toHaveProperty('logout_url');
    expect(res.clearCookie).toHaveBeenCalledWith('harvoost_session', { path: '/' });
  });

  it('revokes the session row when Bearer token is present', async () => {
    const prisma = makePrismaStub();
    const oidc = makeOidcStub();
    const res = makeResStub();
    const ctrl = new AuthController(
      makeEnv(),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      prisma as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      oidc as any,
    );
    await ctrl.logout(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { headers: { authorization: 'Bearer test-token-1' } } as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      res as any,
    );
    const update = prisma.calls.find((c) => /UPDATE sessions SET revoked_at/.test(c.sql));
    expect(update).toBeDefined();
    expect(update!.values[0]).toBe('test-token-1');
  });

  it('revokes the session row when cookie is present (no bearer header)', async () => {
    const prisma = makePrismaStub();
    const oidc = makeOidcStub();
    const res = makeResStub();
    const ctrl = new AuthController(
      makeEnv(),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      prisma as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      oidc as any,
    );
    await ctrl.logout(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { headers: {}, cookies: { harvoost_session: 'cookie-token' } } as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      res as any,
    );
    const update = prisma.calls.find((c) => /UPDATE sessions SET revoked_at/.test(c.sql));
    expect(update).toBeDefined();
    expect(update!.values[0]).toBe('cookie-token');
  });
});
