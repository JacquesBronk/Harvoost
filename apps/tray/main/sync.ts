// SSE client subscribing to /v1/sync/events. Pushes events into the renderer
// over IPC (`sync:event`, `sync:connected`, `sync:auth-expired`). Reconnects
// with exponential backoff (1s → 16s). On 401/403 the loop terminates and
// surfaces `sync:auth-expired` so the renderer can prompt for re-auth.

import type { BrowserWindow } from 'electron';
import { createParser, type EventSourceMessage } from 'eventsource-parser';
import { apiBaseUrl } from './api.js';

// Reconnect ladder: 1s, 2s, 4s, 8s, 16s, then 16s thereafter.
const MAX_BACKOFF_MS = 16_000;

let abortController: AbortController | null = null;

export function connectSyncStream(token: string, window: BrowserWindow) {
  let attempt = 0;

  async function loop() {
    if (abortController) abortController.abort();
    abortController = new AbortController();
    const { signal } = abortController;

    try {
      const response = await fetch(`${apiBaseUrl}/v1/sync/events`, {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'text/event-stream',
        },
        signal,
      });
      if (response.status === 401 || response.status === 403) {
        // Bearer token has been revoked or expired. Surface to renderer
        // so it can prompt for re-auth, then stop reconnecting until a
        // new token is provided (see `connectSyncStream` recall in auth.ts).
        window.webContents.send('sync:connected', false);
        window.webContents.send('sync:auth-expired', {
          status: response.status,
        });
        return;
      }
      if (!response.ok || !response.body) {
        throw new Error(`Sync stream returned ${response.status}`);
      }
      attempt = 0;
      window.webContents.send('sync:connected', true);

      const parser = createParser({
        onEvent: (event: EventSourceMessage) => {
          window.webContents.send('sync:event', {
            event: event.event ?? 'message',
            data: safeParse(event.data),
          });
        },
      });

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      while (!signal.aborted) {
        const { value, done } = await reader.read();
        if (done) break;
        parser.feed(decoder.decode(value, { stream: true }));
      }
    } catch (err) {
      if (signal.aborted) return;
      window.webContents.send('sync:connected', false);
      const backoff = Math.min(MAX_BACKOFF_MS, 1000 * 2 ** attempt);
      attempt += 1;
      // eslint-disable-next-line no-console
      console.warn('Sync stream reconnecting in', backoff, 'ms', err);
      setTimeout(loop, backoff);
    }
  }

  loop().catch((err) => {
    // eslint-disable-next-line no-console
    console.error('Sync stream loop crashed', err);
  });
}

export function disconnectSyncStream() {
  abortController?.abort();
  abortController = null;
}

function safeParse(input: string | undefined): unknown {
  if (!input) return undefined;
  try {
    return JSON.parse(input);
  } catch {
    return input;
  }
}
