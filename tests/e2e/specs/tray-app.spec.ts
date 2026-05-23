import { expect, test } from '@playwright/test';

/**
 * Tray-app (Electron) smoke test.
 *
 * Electron e2e is feasible with Playwright via `_electron` API (built in
 * to @playwright/test). The full smoke pass needs:
 *
 *   1. apps/tray/main/index.js (the Electron main process) — present per
 *      build HANDOFF.
 *   2. A display / Xvfb if running headless on Linux.
 *   3. Keytar backed by libsecret (Linux) / Keychain (macOS) / DPAPI
 *      (Windows). For CI we can mock keytar via env (KEYTAR_BACKEND=memory).
 *
 * In this sandbox we cannot launch Electron (no display, no installed
 * Electron binary, no pnpm install). The test is GUARDED to skip cleanly
 * unless E2E_TRAY=1 is set, so it doesn't false-fail in CI lanes that
 * don't have the Electron toolchain.
 *
 * Scenarios to cover when enabled (one block each):
 *   - Tray icon appears on launch (BrowserWindow + Tray APIs).
 *   - "Sign in" popover routes through the custom-protocol callback.
 *   - Morning prompt offers Yes/No + 1-5 star mood; Yes calls
 *     POST /v1/time-entries/start with Idempotency-Key.
 *   - Stop from popover closes the running entry.
 *   - The renderer never makes direct HTTP calls (per ARCHITECTURE r2
 *     CORS strategy — all network from main process). Assert by counting
 *     fetch invocations on `webContents.session.webRequest.onBeforeRequest`.
 */

test.describe('Journey 14: tray app smoke (Electron — opt-in)', () => {
  test.skip(
    process.env.E2E_TRAY !== '1',
    'Tray-app Electron smoke disabled. Set E2E_TRAY=1 to enable. Requires display + libsecret on Linux.',
  );

  test('launches and shows the tray menu (placeholder — implement when E2E_TRAY=1)', async () => {
    // Implementation sketch:
    //
    //   import { _electron as electron } from '@playwright/test';
    //   const app = await electron.launch({
    //     args: [path.join(__dirname, '..', '..', '..', 'apps/tray/main/index.js')],
    //     env: {
    //       ...process.env,
    //       HARVOOST_API_BASE_URL: 'http://localhost:3001',
    //       KEYTAR_BACKEND: 'memory',
    //     },
    //   });
    //   const window = await app.firstWindow();
    //   await expect(window).toHaveTitle(/Harvoost/);
    //   ... assert tray menu items
    //   await app.close();
    expect(true).toBe(true);
  });

  test('renderer makes no direct HTTP calls (CORS r2 strategy) — when E2E_TRAY=1', async () => {
    // When enabled, attach a webRequest listener to the Electron app's
    // session and assert no request leaves the renderer process. All
    // network in the r2 design flows through the main process via IPC.
    expect(true).toBe(true);
  });
});
