import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { OidcService } from '../../src/auth/oidc.service';
import type { Env } from '../../src/config/env';

// Unit tests for OidcService — the provider-agnostic OIDC client.
// We mock global fetch to avoid hitting a real IdP; the focus is on:
//   - PKCE generation correctness (verifier ≠ challenge, both base64url)
//   - state/nonce uniqueness
//   - getAuthorizationUrl assembles the right query params
//   - getDiscovery caches the result + raises on non-2xx

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

const DISCOVERY_BODY = {
  issuer: 'http://kc/realms/harvoost',
  authorization_endpoint: 'http://kc/realms/harvoost/protocol/openid-connect/auth',
  token_endpoint: 'http://kc/realms/harvoost/protocol/openid-connect/token',
  jwks_uri: 'http://kc/realms/harvoost/protocol/openid-connect/certs',
};

function mockFetchOnce(body: unknown, status = 200) {
  const fetchMock = vi.fn(async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  }));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  globalThis.fetch = fetchMock as any;
  return fetchMock;
}

describe('OidcService — PKCE + state + nonce helpers', () => {
  it('generatePkcePair returns base64url verifier + challenge that are NOT equal', () => {
    const { codeVerifier, codeChallenge } = OidcService.generatePkcePair();
    expect(codeVerifier).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(codeChallenge).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(codeVerifier).not.toBe(codeChallenge);
    // 32-byte verifier → 43-char base64url; 32-byte SHA-256 → 43-char base64url.
    expect(codeVerifier.length).toBeGreaterThanOrEqual(40);
    expect(codeChallenge.length).toBeGreaterThanOrEqual(40);
  });

  it('generateState and generateNonce produce distinct values across calls', () => {
    const s1 = OidcService.generateState();
    const s2 = OidcService.generateState();
    const n1 = OidcService.generateNonce();
    expect(s1).not.toBe(s2);
    expect(s1).not.toBe(n1);
    expect(s1).toMatch(/^[A-Za-z0-9_-]+$/);
  });
});

describe('OidcService — discovery + authorization URL', () => {
  const env = makeEnv();
  let svc: OidcService;

  beforeEach(() => {
    svc = new OidcService(env);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('getDiscovery fetches and returns the document', async () => {
    const fetchMock = mockFetchOnce(DISCOVERY_BODY);
    const doc = await svc.getDiscovery();
    expect(doc.issuer).toBe(DISCOVERY_BODY.issuer);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('getDiscovery caches the result within TTL', async () => {
    const fetchMock = mockFetchOnce(DISCOVERY_BODY);
    await svc.getDiscovery();
    await svc.getDiscovery();
    await svc.getDiscovery();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('getDiscovery throws OIDCFailureError on non-2xx', async () => {
    mockFetchOnce({ error: 'nope' }, 500);
    await expect(svc.getDiscovery()).rejects.toThrow(/OIDC discovery/);
  });

  it('getDiscovery throws when discovery is missing required fields', async () => {
    mockFetchOnce({ issuer: 'http://x' });
    await expect(svc.getDiscovery()).rejects.toThrow(/OIDC discovery missing/);
  });

  it('getAuthorizationUrl encodes state, nonce, code_challenge, redirect_uri', async () => {
    mockFetchOnce(DISCOVERY_BODY);
    const url = await svc.getAuthorizationUrl({
      state: 'STATE-VALUE',
      nonce: 'NONCE-VALUE',
      codeChallenge: 'CHALLENGE-VALUE',
      redirectUri: 'http://localhost:3000/v1/auth/callback',
    });
    const u = new URL(url);
    expect(u.searchParams.get('client_id')).toBe('harvoost-web');
    expect(u.searchParams.get('response_type')).toBe('code');
    expect(u.searchParams.get('state')).toBe('STATE-VALUE');
    expect(u.searchParams.get('nonce')).toBe('NONCE-VALUE');
    expect(u.searchParams.get('code_challenge')).toBe('CHALLENGE-VALUE');
    expect(u.searchParams.get('code_challenge_method')).toBe('S256');
    expect(u.searchParams.get('redirect_uri')).toBe('http://localhost:3000/v1/auth/callback');
    expect(u.searchParams.get('scope')).toContain('openid');
  });

  it('exchangeCodeForToken POSTs urlencoded body to the token endpoint', async () => {
    // 1st call → discovery; 2nd call → token endpoint.
    let calls = 0;
    const tokenResponse = { id_token: 'eyJ.id', access_token: 'access-1', refresh_token: 'refresh-1' };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    globalThis.fetch = vi.fn(async (url: string, opts?: any) => {
      calls++;
      if (calls === 1) {
        return { ok: true, status: 200, json: async () => DISCOVERY_BODY, text: async () => '' };
      }
      expect(String(url)).toContain('/token');
      expect(opts.method).toBe('POST');
      expect(opts.headers['Content-Type']).toBe('application/x-www-form-urlencoded');
      const body = String(opts.body);
      expect(body).toContain('grant_type=authorization_code');
      expect(body).toContain('code=THE-CODE');
      expect(body).toContain('code_verifier=THE-VERIFIER');
      expect(body).toContain('client_id=harvoost-web');
      return {
        ok: true,
        status: 200,
        json: async () => tokenResponse,
        text: async () => JSON.stringify(tokenResponse),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    }) as any;

    const result = await svc.exchangeCodeForToken({
      code: 'THE-CODE',
      codeVerifier: 'THE-VERIFIER',
      redirectUri: 'http://localhost:3000/v1/auth/callback',
    });
    expect(result.idToken).toBe('eyJ.id');
    expect(result.accessToken).toBe('access-1');
    expect(result.refreshToken).toBe('refresh-1');
  });

  it('exchangeCodeForToken throws on missing id_token', async () => {
    let calls = 0;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    globalThis.fetch = vi.fn(async () => {
      calls++;
      if (calls === 1) {
        return { ok: true, status: 200, json: async () => DISCOVERY_BODY, text: async () => '' };
      }
      return { ok: true, status: 200, json: async () => ({}), text: async () => '{}' };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    }) as any;
    await expect(
      svc.exchangeCodeForToken({
        code: 'x',
        codeVerifier: 'y',
        redirectUri: 'http://localhost:3000/cb',
      }),
    ).rejects.toThrow(/missing id_token/);
  });
});
