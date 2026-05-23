import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from '../../src/app.module';

// Happy-path e2e: GET /v1/health works without auth. Full e2e is the e2e-tester phase's job.
describe('GET /v1/health (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    // Set env defaults for a minimal test boot.
    process.env.NODE_ENV = 'test';
    process.env.DATABASE_URL = process.env.DATABASE_URL ?? 'postgresql://localhost/harvoost_test';
    process.env.LLM_PROVIDER = 'mock';
    process.env.LLM_MODEL_ID = 'mock-test';
    // OIDC config — required even in tests (env schema mandates these).
    process.env.OIDC_ISSUER_URL = process.env.OIDC_ISSUER_URL ?? 'http://localhost:8080/realms/harvoost';
    process.env.OIDC_CLIENT_ID = process.env.OIDC_CLIENT_ID ?? 'harvoost-web';
    // Test-only bypass so any endpoint requiring auth in this e2e file works without a full OIDC handshake.
    process.env.TEST_AUTH_BYPASS = process.env.TEST_AUTH_BYPASS ?? '1';
    process.env.SESSION_SECRET = process.env.SESSION_SECRET ?? 'dev-session-secret-not-for-prod-replace-with-random-32-bytes';
    process.env.AUDIT_HASH_SECRET = process.env.AUDIT_HASH_SECRET ?? 'dev-audit-secret-not-for-prod-replace-with-random-32-bytes';
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = mod.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
  });

  it('returns a composite status object', async () => {
    const res = await request(app.getHttpServer()).get('/v1/health');
    expect([200, 503]).toContain(res.status);
    expect(res.body).toHaveProperty('status');
    expect(res.body).toHaveProperty('llm');
    expect(res.body.llm).toHaveProperty('provider');
  });
});
