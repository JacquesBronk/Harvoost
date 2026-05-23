/**
 * Throwaway Playwright config for the INC-003 repro spec.
 * Mirrors the live `chromium-live` project from tests/e2e/playwright.config.ts
 * but points testDir at this incident repro folder so we do not touch the
 * canonical suite. Run from tests/e2e so node_modules + the @playwright/test
 * install resolve:
 *   cd tests/e2e
 *   E2E_LIVE=1 E2E_SKIP_WEB_SERVER=1 pnpm exec playwright test \
 *     --config ../../.hacktogether/runs/<run>/incidents/INC-003/repro/playwright.repro.config.ts \
 *     --reporter=list
 */
import { defineConfig, devices } from '@playwright/test';

const WEB_BASE_URL = process.env.E2E_WEB_BASE_URL ?? 'http://localhost:3000';
const API_BASE_URL = process.env.E2E_API_BASE_URL ?? 'http://localhost:3001';
const KEYCLOAK_URL = process.env.E2E_KEYCLOAK_URL ?? 'http://localhost:8080';

export default defineConfig({
  testDir: '.',
  fullyParallel: false,
  workers: 1,
  timeout: 120_000,
  expect: { timeout: 10_000 },
  reporter: 'list',
  use: {
    baseURL: WEB_BASE_URL,
    trace: 'retain-on-failure',
    actionTimeout: 15_000,
    navigationTimeout: 30_000,
    locale: 'en-GB',
    timezoneId: 'Africa/Johannesburg',
    extraHTTPHeaders: {
      'x-harvoost-api-base': API_BASE_URL,
      'x-harvoost-keycloak': KEYCLOAK_URL,
    },
  },
  projects: [
    { name: 'chromium-live', use: { ...devices['Desktop Chrome'] } },
  ],
});
