// Throwaway INC-004 repro config. To re-run, COPY this into tests/e2e/ (so
// Playwright module resolution + tsconfig match the e2e package), then:
//   cd tests/e2e
//   E2E_LIVE=1 E2E_SKIP_WEB_SERVER=1 \
//     INC004_OUT=<incident>/repro/out/result \
//     npx playwright test --config playwright.inc004.config.ts --project=chromium-live
// (stack must be up: web:3000, api:3001, keycloak:8080, postgres seeded.)
// Pace: each test does one live OIDC sign-in; the AuthController bucket is
// 5/60s, so the two tests are spread one-per-window automatically.
import { defineConfig, devices } from '@playwright/test';

const WEB_BASE_URL = process.env.E2E_WEB_BASE_URL ?? 'http://localhost:3000';
const API_BASE_URL = process.env.E2E_API_BASE_URL ?? 'http://localhost:3001';
const KEYCLOAK_URL = process.env.E2E_KEYCLOAK_URL ?? 'http://localhost:8080';

export default defineConfig({
  testDir:
    '/mnt/c/Projects/Harvoost/.hacktogether/runs/87edeba4-9a80-4a73-858b-548fd9026da4/incidents/INC-004/repro',
  fullyParallel: false,
  workers: 1,
  reporter: 'list',
  timeout: 180_000,
  expect: { timeout: 10_000 },
  use: {
    baseURL: WEB_BASE_URL,
    trace: 'off',
    screenshot: 'only-on-failure',
    locale: 'en-GB',
    timezoneId: 'Africa/Johannesburg',
    extraHTTPHeaders: {
      'x-harvoost-api-base': API_BASE_URL,
      'x-harvoost-keycloak': KEYCLOAK_URL,
    },
  },
  projects: [{ name: 'chromium-live', use: { ...devices['Desktop Chrome'] } }],
  webServer: undefined,
});
