/**
 * Harvoost end-to-end Playwright config.
 *
 * Test approach (TEST_REPORT.md § E2E for full discussion):
 *
 * The Harvoost stack is a Next.js web app (apps/web on :3000) backed by a
 * NestJS API (apps/api on :3001). Two flavours of e2e are wired in this
 * config:
 *
 *   1. "mocked-api" project (default in CI): each spec uses page.route() to
 *      intercept calls to API_BASE_URL and return canned RBAC-aware fixtures
 *      drawn from RBAC_TEST_FIXTURE. This keeps the suite hermetic and lets
 *      us exercise the FRONTEND user-journey logic (routing, login flow,
 *      timesheet submission, RBAC-driven nav, chatbot input/output rendering,
 *      out-of-scope refusals, etc.) without needing the full backend.
 *
 *   2. "live-stack" project (opt-in via E2E_LIVE=1): expects apps/web and
 *      apps/api to be reachable at the configured base URLs, plus a seeded
 *      Postgres AND a running Keycloak (per ADR-0001). Most hermetic specs
 *      assert on the in-process mock-state and are skipped in live mode via
 *      `test.skip(isLiveMode(), ...)`. The live lane focuses on the OIDC
 *      handshake (oidc-flow.spec.ts) plus any spec that is mode-agnostic
 *      (e.g., security-headers.spec.ts asserts response headers which both
 *      modes produce identically).
 *
 * Cross-browser: Chromium is the canonical engine. Firefox is added when a
 * live stack is available so we exercise the OIDC redirect chain on a
 * second browser engine.
 *
 * Keycloak prerequisites (live mode only):
 *   docker compose up -d postgres keycloak
 *   # wait for keycloak healthcheck, then seed Harvoost DB:
 *   pnpm db:migrate && pnpm db:seed
 *   E2E_LIVE=1 pnpm --filter @harvoost/e2e e2e
 */

import { defineConfig, devices } from '@playwright/test';

const WEB_BASE_URL = process.env.E2E_WEB_BASE_URL ?? 'http://localhost:3000';
const API_BASE_URL = process.env.E2E_API_BASE_URL ?? 'http://localhost:3001';
const KEYCLOAK_URL = process.env.E2E_KEYCLOAK_URL ?? 'http://localhost:8080';

const live = process.env.E2E_LIVE === '1';

export default defineConfig({
  testDir: './specs',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 2 : undefined,
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : 'list',
  // Live mode: the OIDC redirect chain (web → backend → Keycloak login page →
  // back to backend → web) eats wall-clock. Extend the default timeout so a
  // slow Keycloak boot doesn't cause spurious failures.
  timeout: live ? 60_000 : 30_000,
  expect: { timeout: live ? 10_000 : 5_000 },

  use: {
    baseURL: WEB_BASE_URL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    actionTimeout: live ? 15_000 : 10_000,
    navigationTimeout: live ? 30_000 : 15_000,
    locale: 'en-GB',
    timezoneId: 'Africa/Johannesburg',
    extraHTTPHeaders: {
      // Expose the API base URL to tests so route mocks know which origin to intercept.
      'x-harvoost-api-base': API_BASE_URL,
      // Likewise expose Keycloak so the live login helper picks the right URL.
      'x-harvoost-keycloak': KEYCLOAK_URL,
    },
  },

  projects: live
    ? [
        {
          // Live project — runs all specs. The `test.skip(isLiveMode(), ...)`
          // guards inside hermetic-only specs (auth.spec.ts, csrf.spec.ts,
          // throttle.spec.ts, etc.) cause those to skip cleanly. The
          // load-bearing live specs (oidc-flow.spec.ts, the live half of
          // auth.spec.ts) drive the real Keycloak handshake.
          name: 'chromium-live',
          use: { ...devices['Desktop Chrome'] },
        },
        {
          name: 'firefox-live',
          use: { ...devices['Desktop Firefox'] },
        },
      ]
    : [
        {
          name: 'chromium-mocked',
          use: { ...devices['Desktop Chrome'] },
        },
      ],

  // Boot the web dev server only when a live stack is requested. In mocked
  // mode the dev server is still required (the web app shell loads under a
  // real Next.js runtime; only the API origin is intercepted).
  webServer:
    process.env.E2E_SKIP_WEB_SERVER === '1'
      ? undefined
      : {
          command: 'pnpm --filter @harvoost/web dev',
          cwd: '../..',
          url: WEB_BASE_URL,
          reuseExistingServer: !process.env.CI,
          timeout: 180_000,
        },
});
