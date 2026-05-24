import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { AppModule } from './app.module';
import { loadEnv } from './config/env';
import { CsrfMiddleware } from './common/middleware/csrf.middleware';

// Postgres bigint columns surface as JS BigInt via $queryRaw; JSON.stringify cannot
// serialize BigInt. Render them as decimal strings (the API already returns string IDs
// everywhere else). Installed process-wide before bootstrap so it covers the older list
// endpoints (GET /v1/users, /v1/projects, /v1/clients) that return raw rows.
(BigInt.prototype as unknown as { toJSON: () => string }).toJSON = function () {
  return this.toString();
};

async function bootstrap() {
  const env = loadEnv();
  const logger = new Logger('Bootstrap');

  // WORKER_MODE: spin up the pg-boss worker process and exit out of HTTP serving.
  if (env.WORKER_MODE) {
    logger.log(`Starting in WORKER_MODE — pg-boss only, no HTTP server.`);
    // TODO(build-phase-followup): boot pg-boss, registerJobs from @harvoost/jobs.
    // Stubbed: just stay alive so the container doesn't crash-loop.
    setInterval(() => {}, 60_000);
    return;
  }

  const app = await NestFactory.create(AppModule, {
    logger: ['error', 'warn', 'log'],
    cors: {
      origin: env.CORS_ALLOWED_ORIGINS.split(',').map((s) => s.trim()),
      credentials: true,
      // INC-005 (issue #8) Fix D — the throttler sets a Retry-After-<bucket>
      // header on 429s (verified against @nestjs/throttler v6.5.0 source: the
      // suffix is the blocking bucket's name, `-global`/`-auth`; `default`
      // emits bare `Retry-After`). Browsers cannot read response headers cross
      // origin unless they are listed here, so the web client's 429 backoff
      // could not honour the hint. Expose all three the client may see.
      exposedHeaders: ['Retry-After-global', 'Retry-After-auth', 'Retry-After'],
    },
  });

  // Finding 10 — Helmet for security response headers (HSTS, X-Content-Type-Options, etc).
  // CSP is disabled because the API serves JSON only — the web app's CSP belongs in Next.
  app.use(
    helmet({
      contentSecurityPolicy: false,
      hsts: { maxAge: 31536000, includeSubDomains: true, preload: false },
      referrerPolicy: { policy: 'no-referrer' },
    }),
  );

  // Finding 7 — cookie parser so the bearer guard can read the HttpOnly session cookie.
  app.use(cookieParser());

  // Finding 8 — CSRF Origin/X-Requested-With check on state-changing routes.
  // Instantiate manually so it picks up env from loadEnv() above (the same instance
  // used by the env module via DI).
  const csrf = new CsrfMiddleware(env);
  app.use(csrf.use.bind(csrf));

  // Validation is per-handler via ZodValidationPipe; no global pipe needed.
  await app.listen(env.PORT);
  logger.log(`Harvoost API listening on :${env.PORT} (LLM_PROVIDER=${env.LLM_PROVIDER}, OIDC_ISSUER_URL=${env.OIDC_ISSUER_URL})`);
}

bootstrap().catch((err) => {
  // Boot failure — print and exit nonzero so the container restarts (or fails fast in CI).
  // eslint-disable-next-line no-console
  console.error('FATAL bootstrap error:', err);
  process.exit(1);
});
