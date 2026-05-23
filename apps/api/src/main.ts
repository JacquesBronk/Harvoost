import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { AppModule } from './app.module';
import { loadEnv } from './config/env';
import { CsrfMiddleware } from './common/middleware/csrf.middleware';

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
