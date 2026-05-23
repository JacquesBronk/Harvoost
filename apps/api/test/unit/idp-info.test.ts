import { describe, it, expect, vi } from 'vitest';
import { AuthController } from '../../src/auth/auth.controller';
import type { Env } from '../../src/config/env';

// Unit tests for AuthController.idpInfo — the PUBLIC GET /v1/auth/idp-info
// endpoint that drives provider-agnostic login-page copy (ADR-0001 / INC-002).
//
// Covered:
//   - env-var path: OIDC_DISPLAY_NAME wins; issuer comes from discovery.
//   - discovery-fallback path: discovery throws -> issuer falls back to
//     OIDC_ISSUER_URL and the endpoint still resolves (never fails).
//   - derived-name path: OIDC_DISPLAY_NAME unset -> name derived from issuer host.
//   - final fallback: unparseable issuer + no env var -> "your identity provider".

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

function makeOidcStub(opts: { discoveryIssuer?: string; discoveryThrows?: Error } = {}) {
  return {
    getDiscovery: vi.fn(async () => {
      if (opts.discoveryThrows) throw opts.discoveryThrows;
      return {
        issuer: opts.discoveryIssuer ?? 'http://kc.example/realms/harvoost',
        authorization_endpoint: 'http://kc.example/auth',
        token_endpoint: 'http://kc.example/token',
        jwks_uri: 'http://kc.example/certs',
      };
    }),
  };
}

function makeCtrl(env: Env, oidc: ReturnType<typeof makeOidcStub>): AuthController {
  return new AuthController(
    env,
    // prisma is not touched by idpInfo.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    {} as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    oidc as any,
  );
}

describe('AuthController.idpInfo', () => {
  it('returns OIDC_DISPLAY_NAME and the discovery issuer (env-var path)', async () => {
    const oidc = makeOidcStub({ discoveryIssuer: 'http://kc.example/realms/harvoost' });
    const ctrl = makeCtrl(makeEnv({ OIDC_DISPLAY_NAME: 'Keycloak' }), oidc);

    const out = await ctrl.idpInfo();

    expect(out.display_name).toBe('Keycloak');
    expect(out.issuer).toBe('http://kc.example/realms/harvoost');
    expect(oidc.getDiscovery).toHaveBeenCalledTimes(1);
  });

  it('trims whitespace-only OIDC_DISPLAY_NAME and falls through to derived name', async () => {
    const oidc = makeOidcStub({ discoveryIssuer: 'https://login.microsoftonline.com/tenant/v2.0' });
    const ctrl = makeCtrl(makeEnv({ OIDC_DISPLAY_NAME: '   ' }), oidc);

    const out = await ctrl.idpInfo();

    // Whitespace-only is treated as unset -> derived from issuer host.
    expect(out.display_name).toBe('login.microsoftonline.com');
    expect(out.issuer).toBe('https://login.microsoftonline.com/tenant/v2.0');
  });

  it('falls back to OIDC_ISSUER_URL when discovery is unreachable (discovery-fallback path)', async () => {
    const oidc = makeOidcStub({ discoveryThrows: new Error('ECONNREFUSED') });
    const ctrl = makeCtrl(
      makeEnv({
        OIDC_DISPLAY_NAME: 'Microsoft Entra ID',
        OIDC_ISSUER_URL: 'https://login.microsoftonline.com/abc/v2.0',
      }),
      oidc,
    );

    const out = await ctrl.idpInfo();

    // Endpoint must NOT throw — it degrades gracefully to the configured issuer.
    expect(out.display_name).toBe('Microsoft Entra ID');
    expect(out.issuer).toBe('https://login.microsoftonline.com/abc/v2.0');
  });

  it('derives display_name from the issuer host when OIDC_DISPLAY_NAME is unset', async () => {
    const oidc = makeOidcStub({ discoveryIssuer: 'http://localhost:8080/realms/harvoost' });
    const ctrl = makeCtrl(makeEnv({ OIDC_DISPLAY_NAME: undefined }), oidc);

    const out = await ctrl.idpInfo();

    expect(out.display_name).toBe('localhost');
    expect(out.issuer).toBe('http://localhost:8080/realms/harvoost');
  });

  it('falls back to "your identity provider" when no env var and issuer is unparseable', async () => {
    // Discovery throws AND the configured issuer is not a valid URL -> last-resort literal.
    const oidc = makeOidcStub({ discoveryThrows: new Error('down') });
    const ctrl = makeCtrl(
      makeEnv({ OIDC_DISPLAY_NAME: undefined, OIDC_ISSUER_URL: 'not-a-url' }),
      oidc,
    );

    const out = await ctrl.idpInfo();

    expect(out.display_name).toBe('your identity provider');
    expect(out.issuer).toBe('not-a-url');
  });
});
