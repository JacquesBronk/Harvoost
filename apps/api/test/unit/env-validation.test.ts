import { describe, it, expect } from 'vitest';
import { loadEnv } from '../../src/config/env';

// Boot-time invariant tests — ensure the API refuses to start with bad LLM
// config OR bad OIDC config OR a misplaced TEST_AUTH_BYPASS.

const MIN_ENV = {
  DATABASE_URL: 'postgresql://localhost/harvoost_test',
  NODE_ENV: 'test',
  SESSION_SECRET: 'dev-session-secret-not-for-prod-replace-with-random-32-bytes',
  AUDIT_HASH_SECRET: 'dev-audit-secret-not-for-prod-replace-with-random-32-bytes',
  OIDC_ISSUER_URL: 'http://localhost:8080/realms/harvoost',
  OIDC_CLIENT_ID: 'harvoost-web',
};

describe('loadEnv — boot-time invariants', () => {
  it('returns a parsed env with defaults when required fields are present', () => {
    const env = loadEnv({ ...MIN_ENV });
    expect(env.NODE_ENV).toBe('test');
    expect(env.LLM_PROVIDER).toBe('mock');
    expect(env.PORT).toBe(3001);
    expect(env.OIDC_ISSUER_URL).toBe('http://localhost:8080/realms/harvoost');
    expect(env.OIDC_CLIENT_ID).toBe('harvoost-web');
  });

  it('throws when DATABASE_URL is missing', () => {
    const env: Record<string, string> = { ...MIN_ENV };
    delete env.DATABASE_URL;
    expect(() => loadEnv(env)).toThrow(/DATABASE_URL/);
  });

  it('throws when OIDC_ISSUER_URL is missing', () => {
    const env: Record<string, string> = { ...MIN_ENV };
    delete env.OIDC_ISSUER_URL;
    expect(() => loadEnv(env)).toThrow(/OIDC_ISSUER_URL/);
  });

  it('throws when OIDC_ISSUER_URL is not a URL', () => {
    expect(() =>
      loadEnv({ ...MIN_ENV, OIDC_ISSUER_URL: 'not-a-url' }),
    ).toThrow(/OIDC_ISSUER_URL/);
  });

  it('throws when OIDC_CLIENT_ID is missing', () => {
    const env: Record<string, string> = { ...MIN_ENV };
    delete env.OIDC_CLIENT_ID;
    expect(() => loadEnv(env)).toThrow(/OIDC_CLIENT_ID/);
  });

  it('throws LLMConfigError when LLM_PROVIDER=openai but OPENAI_API_KEY is unset', () => {
    expect(() =>
      loadEnv({
        ...MIN_ENV,
        LLM_PROVIDER: 'openai',
        LLM_MODEL_ID: 'gpt-4o',
      }),
    ).toThrow(/LLMConfigError.*OPENAI_API_KEY/);
  });

  it('throws when LLM_PROVIDER=anthropic but ANTHROPIC_API_KEY is unset', () => {
    expect(() =>
      loadEnv({ ...MIN_ENV, LLM_PROVIDER: 'anthropic', LLM_MODEL_ID: 'claude-sonnet-4-5' }),
    ).toThrow(/LLMConfigError.*ANTHROPIC_API_KEY/);
  });

  it('throws when LLM_PROVIDER=google but GOOGLE_GENERATIVE_AI_API_KEY is unset', () => {
    expect(() =>
      loadEnv({ ...MIN_ENV, LLM_PROVIDER: 'google', LLM_MODEL_ID: 'gemini-1.5-pro' }),
    ).toThrow(/LLMConfigError.*GOOGLE_GENERATIVE_AI_API_KEY/);
  });

  it('throws when LLM_PROVIDER=ollama but OLLAMA_BASE_URL is unset', () => {
    expect(() =>
      loadEnv({ ...MIN_ENV, LLM_PROVIDER: 'ollama', LLM_MODEL_ID: 'llama3.1' }),
    ).toThrow(/LLMConfigError.*OLLAMA_BASE_URL/);
  });

  it('accepts openai + OPENAI_API_KEY (success path)', () => {
    const env = loadEnv({
      ...MIN_ENV,
      LLM_PROVIDER: 'openai',
      LLM_MODEL_ID: 'gpt-4o',
      OPENAI_API_KEY: 'sk-test',
    });
    expect(env.LLM_PROVIDER).toBe('openai');
    expect(env.OPENAI_API_KEY).toBe('sk-test');
  });

  it('rejects unknown LLM_PROVIDER values at the zod layer', () => {
    expect(() =>
      loadEnv({ ...MIN_ENV, LLM_PROVIDER: 'nonexistent-provider' as unknown as string }),
    ).toThrow();
  });

  it('rejects port outside the valid range', () => {
    expect(() => loadEnv({ ...MIN_ENV, PORT: '70000' })).toThrow();
  });

  it('SESSION_SECRET shorter than 32 chars is rejected', () => {
    expect(() => loadEnv({ ...MIN_ENV, SESSION_SECRET: 'short' })).toThrow();
  });

  it('refuses to boot in production with default BOOTSTRAP_ADMIN_EMAIL', () => {
    expect(() =>
      loadEnv({
        ...MIN_ENV,
        NODE_ENV: 'production',
        SESSION_SECRET: 'a'.repeat(32),
        AUDIT_HASH_SECRET: 'a'.repeat(32),
      }),
    ).toThrow(/BOOTSTRAP_ADMIN_EMAIL/);
  });

  it('refuses to boot in production with dev- prefixed secrets', () => {
    expect(() =>
      loadEnv({
        ...MIN_ENV,
        NODE_ENV: 'production',
        BOOTSTRAP_ADMIN_EMAIL: 'real-admin@example.com',
        SESSION_SECRET: 'dev-session-secret-not-for-prod-replace-with-random-32-bytes',
        AUDIT_HASH_SECRET: 'a'.repeat(40),
      }),
    ).toThrow(/dev placeholder in production/);
  });

  it('refuses to boot in production with TEST_AUTH_BYPASS=true', () => {
    expect(() =>
      loadEnv({
        ...MIN_ENV,
        NODE_ENV: 'production',
        BOOTSTRAP_ADMIN_EMAIL: 'real-admin@example.com',
        SESSION_SECRET: 'a'.repeat(32),
        AUDIT_HASH_SECRET: 'a'.repeat(32),
        TEST_AUTH_BYPASS: 'true',
      }),
    ).toThrow(/TEST_AUTH_BYPASS=true outside NODE_ENV=test/);
  });

  it('refuses to boot in development with TEST_AUTH_BYPASS=true', () => {
    expect(() =>
      loadEnv({
        ...MIN_ENV,
        NODE_ENV: 'development',
        TEST_AUTH_BYPASS: 'true',
      }),
    ).toThrow(/TEST_AUTH_BYPASS=true outside NODE_ENV=test/);
  });

  it('accepts TEST_AUTH_BYPASS=true in NODE_ENV=test', () => {
    const env = loadEnv({
      ...MIN_ENV,
      NODE_ENV: 'test',
      TEST_AUTH_BYPASS: 'true',
    });
    expect(env.TEST_AUTH_BYPASS).toBe(true);
  });
});
