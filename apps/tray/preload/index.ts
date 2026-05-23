// Preload script. Exposes a NARROW, TYPED API to the renderer via contextBridge.
// The renderer cannot import Node modules directly — all I/O goes through here.
//
// CORS: see ARCHITECTURE.md § Electron CORS strategy r2.

import { contextBridge, ipcRenderer } from 'electron';

export interface ApiCallOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  body?: unknown;
  headers?: Record<string, string>;
  idempotent?: boolean;
}

export interface ApiResult<T = unknown> {
  ok: boolean;
  status: number;
  data?: T;
  error?: { code: string; message: string; details?: unknown };
}

export interface SyncEvent {
  event: string;
  data: unknown;
}

const harvoostApi = {
  api: {
    request<T = unknown>(path: string, options?: ApiCallOptions): Promise<ApiResult<T>> {
      return ipcRenderer.invoke('harvoost:api', { path, options });
    },
  },
  auth: {
    signIn(): Promise<{ started: boolean }> {
      return ipcRenderer.invoke('harvoost:auth:sign-in');
    },
    signOut(): Promise<void> {
      return ipcRenderer.invoke('harvoost:auth:sign-out');
    },
    onToken(token: string): Promise<void> {
      return ipcRenderer.invoke('harvoost:auth:on-token', token);
    },
  },
  sync: {
    onEvent(listener: (event: SyncEvent) => void): () => void {
      const handler = (_event: Electron.IpcRendererEvent, payload: SyncEvent) =>
        listener(payload);
      ipcRenderer.on('sync:event', handler);
      return () => ipcRenderer.removeListener('sync:event', handler);
    },
    onConnectionChange(listener: (connected: boolean) => void): () => void {
      const handler = (_event: Electron.IpcRendererEvent, connected: boolean) =>
        listener(connected);
      ipcRenderer.on('sync:connected', handler);
      return () => ipcRenderer.removeListener('sync:connected', handler);
    },
    onAuthExpired(listener: (payload: { status: number }) => void): () => void {
      const handler = (
        _event: Electron.IpcRendererEvent,
        payload: { status: number },
      ) => listener(payload);
      ipcRenderer.on('sync:auth-expired', handler);
      return () => ipcRenderer.removeListener('sync:auth-expired', handler);
    },
  },
};

contextBridge.exposeInMainWorld('harvoost', harvoostApi);

// For type augmentation in the renderer:
export type HarvoostBridge = typeof harvoostApi;
