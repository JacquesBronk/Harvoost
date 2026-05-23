// Typed IPC bridge: renderer ↔ main.
// The renderer calls `window.harvoost.api.request(...)`; the preload script
// forwards via ipcRenderer.invoke; this module handles each channel.
//
// Channels:
//   harvoost:api       — generic API proxy (renderer never speaks HTTP).
//   harvoost:auth:sign-in — kicks off OIDC PKCE in the system browser.
//   harvoost:auth:sign-out — clears the keychain.

import { ipcMain, type BrowserWindow } from 'electron';
import { apiCall, apiBaseUrl, type ApiCallOptions, type ApiResult } from './api.js';
import { setBearerToken, startSignIn } from './auth.js';
import { connectSyncStream, disconnectSyncStream } from './sync.js';

export interface ApiRequest {
  path: string;
  options?: ApiCallOptions;
}

export function registerIpcHandlers(window: BrowserWindow) {
  ipcMain.handle(
    'harvoost:api',
    async (_event, req: ApiRequest): Promise<ApiResult<unknown>> => {
      if (!req || typeof req.path !== 'string') {
        return {
          ok: false,
          status: 400,
          error: { code: 'BAD_REQUEST', message: 'Invalid API request from renderer' },
        };
      }
      return apiCall(req.path, req.options);
    },
  );

  ipcMain.handle('harvoost:auth:sign-in', async (): Promise<{ started: boolean }> => {
    await startSignIn(apiBaseUrl);
    return { started: true };
  });

  ipcMain.handle('harvoost:auth:sign-out', async (): Promise<void> => {
    disconnectSyncStream();
    await setBearerToken(null);
    window.webContents.send('sync:connected', false);
  });

  ipcMain.handle('harvoost:auth:on-token', async (_event, token: string): Promise<void> => {
    // Renderer can call this after a successful sign-in flow (in case the protocol
    // handler in the main process couldn't complete the exchange itself).
    await setBearerToken(token);
    connectSyncStream(token, window);
  });
}
