import { z } from 'zod';

// Server-side env schema. Validated at boot via main.ts.
// Note: secrets must NEVER be logged. Boot logs print a redacted "loaded N env vars" only.
export const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3001),
  WORKER_MODE: z.coerce.boolean().default(false),

  DATABASE_URL: z.string().min(1),
  SHADOW_DATABASE_URL: z.string().optional(),

  // Secrets — no defaults. Provided via .env.example for local dev (32+ chars there);
  // production deploys must inject via Key Vault.
  SESSION_SECRET: z.string().min(32),
  AUDIT_HASH_SECRET: z.string().min(32),
  BOOTSTRAP_ADMIN_EMAIL: z.string().email().default('admin@harvoost.local'),

  CORS_ALLOWED_ORIGINS: z.string().default('http://localhost:3000'),

  // OIDC (provider-agnostic per ADR-0001).
  // Dev: Keycloak in docker-compose. Prod: Entra ID (Azure AD).
  // The discovery doc is fetched from `${OIDC_ISSUER_URL}/.well-known/openid-configuration`.
  OIDC_ISSUER_URL: z.string().url(),
  OIDC_CLIENT_ID: z.string().min(1),
  OIDC_CLIENT_SECRET: z.string().optional(),
  OIDC_REDIRECT_URI_WEB: z.string().default('http://localhost:3000/v1/auth/callback'),
  OIDC_REDIRECT_URI_TRAY: z.string().default('harvoost://auth/callback'),

  // TEST-only bypass — accepts X-Test-User-Id header in NODE_ENV=test ONLY.
  // The boot invariant below refuses TEST_AUTH_BYPASS=true outside NODE_ENV=test.
  TEST_AUTH_BYPASS: z.coerce.boolean().default(false),

  // LLM provider (default OpenAI per architecture r2).
  LLM_PROVIDER: z.enum(['openai', 'anthropic', 'google', 'xai', 'ollama', 'mock']).default('mock'),
  LLM_MODEL_ID: z.string().default('mock-test'),
  OPENAI_API_KEY: z.string().optional(),
  ANTHROPIC_API_KEY: z.string().optional(),
  GOOGLE_GENERATIVE_AI_API_KEY: z.string().optional(),
  XAI_API_KEY: z.string().optional(),
  OLLAMA_BASE_URL: z.string().optional(),

  // Email + Blob (optional in dev).
  ACS_EMAIL_CONNECTION_STRING: z.string().optional(),
  ACS_EMAIL_SENDER_ADDRESS: z.string().default('noreply@harvoost.local'),
  BLOB_STORAGE_CONNECTION_STRING: z.string().optional(),
  BLOB_EXPORTS_CONTAINER: z.string().default('exports'),

  APPINSIGHTS_CONNECTION_STRING: z.string().optional(),
  WEB_ORIGIN: z.string().default('http://localhost:3000'),
});

export type Env = z.infer<typeof EnvSchema>;

// Boot-time validation. Throws on any failure — the process should refuse to start.
export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = EnvSchema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid env configuration: ${issues}`);
  }
  // Cross-field invariant: when LLM_PROVIDER != mock, the matching key must be set.
  const e = parsed.data;
  if (e.LLM_PROVIDER !== 'mock') {
    const required: Record<Exclude<typeof e.LLM_PROVIDER, 'mock'>, keyof Env> = {
      openai: 'OPENAI_API_KEY',
      anthropic: 'ANTHROPIC_API_KEY',
      google: 'GOOGLE_GENERATIVE_AI_API_KEY',
      xai: 'XAI_API_KEY',
      ollama: 'OLLAMA_BASE_URL',
    };
    const k = required[e.LLM_PROVIDER];
    if (!e[k]) {
      throw new Error(`LLMConfigError: LLM_PROVIDER=${e.LLM_PROVIDER} requires env ${String(k)} to be set.`);
    }
  }

  // SECURITY: production boot invariants. These are belt-and-braces alongside the
  // schema-level defaults — they refuse to boot if a misconfigured prod deploy slips through.
  if (e.NODE_ENV === 'production') {
    if (e.TEST_AUTH_BYPASS) {
      throw new Error('Refusing to boot: TEST_AUTH_BYPASS=true outside NODE_ENV=test.');
    }
    if (e.BOOTSTRAP_ADMIN_EMAIL === 'admin@harvoost.local') {
      throw new Error('Refusing to boot: BOOTSTRAP_ADMIN_EMAIL must be set to a real address in production.');
    }
    if (e.SESSION_SECRET.startsWith('dev-') || e.AUDIT_HASH_SECRET.startsWith('dev-')) {
      throw new Error('Refusing to boot: SESSION_SECRET/AUDIT_HASH_SECRET appears to be a dev placeholder in production.');
    }
  }
  // TEST_AUTH_BYPASS is also refused outside production but in any env that is not 'test'.
  if (e.TEST_AUTH_BYPASS && e.NODE_ENV !== 'test') {
    throw new Error('Refusing to boot: TEST_AUTH_BYPASS=true outside NODE_ENV=test.');
  }
  return e;
}
