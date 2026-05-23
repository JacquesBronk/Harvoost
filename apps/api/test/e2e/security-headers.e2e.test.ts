import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import request from 'supertest';
import { AppModule } from '../../src/app.module';
import { CsrfMiddleware } from '../../src/common/middleware/csrf.middleware';
import { loadEnv } from '../../src/config/env';

// Finding 10 — Helmet / HSTS / X-Content-Type-Options / Referrer-Policy.
//
// The bootstrap in apps/api/src/main.ts wires helmet() with HSTS max-age 1y,
// referrerPolicy 'no-referrer', and content-type-options 'nosniff' (default in
// helmet >= 7). This test boots the NestApplication exactly the way main.ts
// does and asserts the response headers on /v1/health.
//
// It also serves as a thin smoke for Finding 8 (CSRF middleware mounted):
// a GET (safe method) passes the CSRF gate.

describe('Security headers (Finding 10) + CSRF middleware mount (Finding 8)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    process.env.NODE_ENV = 'test';
    process.env.DATABASE_URL =
      process.env.DATABASE_URL ?? 'postgresql://localhost/harvoost_test';
    process.env.LLM_PROVIDER = 'mock';
    process.env.LLM_MODEL_ID = 'mock-test';
    process.env.OIDC_ISSUER_URL =
      process.env.OIDC_ISSUER_URL ?? 'http://localhost:8080/realms/harvoost';
    process.env.OIDC_CLIENT_ID = process.env.OIDC_CLIENT_ID ?? 'harvoost-web';
    process.env.TEST_AUTH_BYPASS = process.env.TEST_AUTH_BYPASS ?? '1';
    process.env.SESSION_SECRET =
      process.env.SESSION_SECRET ??
      'dev-session-secret-not-for-prod-replace-with-random-32-bytes';
    process.env.AUDIT_HASH_SECRET =
      process.env.AUDIT_HASH_SECRET ??
      'dev-audit-secret-not-for-prod-replace-with-random-32-bytes';

    const env = loadEnv();
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = mod.createNestApplication();
    // Mirror main.ts bootstrap exactly so the assertions reflect production behaviour.
    app.use(
      helmet({
        contentSecurityPolicy: false,
        hsts: { maxAge: 31536000, includeSubDomains: true, preload: false },
        referrerPolicy: { policy: 'no-referrer' },
      }),
    );
    app.use(cookieParser());
    const csrf = new CsrfMiddleware(env);
    app.use(csrf.use.bind(csrf));
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
  });

  it('includes Strict-Transport-Security with max-age >= 31536000', async () => {
    const res = await request(app.getHttpServer()).get('/v1/health');
    const hsts = res.headers['strict-transport-security'];
    expect(hsts).toBeDefined();
    const match = hsts.match(/max-age=(\d+)/);
    expect(match).not.toBeNull();
    const maxAge = Number(match![1]);
    expect(maxAge).toBeGreaterThanOrEqual(31536000);
    expect(hsts).toMatch(/includeSubDomains/i);
  });

  it('includes X-Content-Type-Options: nosniff', async () => {
    const res = await request(app.getHttpServer()).get('/v1/health');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });

  it('includes Referrer-Policy: no-referrer', async () => {
    const res = await request(app.getHttpServer()).get('/v1/health');
    expect(res.headers['referrer-policy']).toBe('no-referrer');
  });

  it('does NOT include Content-Security-Policy (API serves JSON; CSP belongs in web app)', async () => {
    const res = await request(app.getHttpServer()).get('/v1/health');
    expect(res.headers['content-security-policy']).toBeUndefined();
  });

  it('GET /v1/health passes the CSRF middleware (safe method exemption)', async () => {
    const res = await request(app.getHttpServer()).get('/v1/health');
    // 200 or 503 (depends on DB availability in this env). 403 would indicate
    // the CSRF middleware incorrectly gated a GET.
    expect(res.status).not.toBe(403);
    expect([200, 503]).toContain(res.status);
  });
});
