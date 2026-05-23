// Thin renderer-side wrapper around window.harvoost (exposed by the preload).
// Keeps call-sites typed and lets us fail gracefully if the preload isn't loaded
// (e.g. running the renderer in a browser tab for dev).

import type { HarvoostBridge } from '../../preload/index.js';

declare global {
  interface Window {
    harvoost?: HarvoostBridge;
  }
}

function bridge(): HarvoostBridge {
  if (!window.harvoost) {
    throw new Error(
      'Harvoost IPC bridge is not available. This renderer must be loaded inside the Electron tray.',
    );
  }
  return window.harvoost;
}

export const ipcClient = {
  apiRequest<T = unknown>(path: string, options?: Parameters<HarvoostBridge['api']['request']>[1]) {
    return bridge().api.request<T>(path, options);
  },
  signIn() {
    return bridge().auth.signIn();
  },
  signOut() {
    return bridge().auth.signOut();
  },
  onSyncEvent(listener: Parameters<HarvoostBridge['sync']['onEvent']>[0]) {
    return bridge().sync.onEvent(listener);
  },
  onConnectionChange(listener: Parameters<HarvoostBridge['sync']['onConnectionChange']>[0]) {
    return bridge().sync.onConnectionChange(listener);
  },
  onAuthExpired(listener: Parameters<HarvoostBridge['sync']['onAuthExpired']>[0]) {
    return bridge().sync.onAuthExpired(listener);
  },
};
