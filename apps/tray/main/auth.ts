// OIDC PKCE flow runs in the system browser; the response comes back via
// the harvoost://auth/callback custom URI scheme. The bearer token is stored
// in the OS keychain via `keytar`. The renderer never sees the token.
//
// TODO(build-phase-followup): wire the full PKCE handshake (code_verifier
// hash + state nonce + exchange against apps/api /v1/auth/oidc/callback).
// The current implementation provides the storage seam and protocol hook.

import { ipcMain, shell } from 'electron';
import { randomBytes, createHash } from 'node:crypto';

const SERVICE = 'harvoost-tray';
const ACCOUNT = 'session-token';

// Lazy require so a missing keytar binary in dev doesn't crash the whole app.
type Keytar = {
  setPassword(service: string, account: string, password: string): Promise<void>;
  getPassword(service: string, account: string): Promise<string | null>;
  deletePassword(service: string, account: string): Promise<boolean>;
};

let keytar: Keytar | null = null;
function getKeytar(): Keytar | null {
  if (keytar) return keytar;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    keytar = require('keytar') as Keytar;
    return keytar;
  } catch {
    // Fallback to in-memory storage so dev still works on machines without keytar.
    let memToken: string | null = null;
    keytar = {
      async setPassword(_s, _a, password) {
        memToken = password;
      },
      async getPassword() {
        return memToken;
      },
      async deletePassword() {
        memToken = null;
        return true;
      },
    };
    return keytar;
  }
}

let pendingPkce: { codeVerifier: string; state: string; createdAt: number } | null = null;

export function initAuth() {
  ipcMain.on('harvoost:protocol-url', (_event, url: string) => {
    handleProtocolUrl(url).catch((err) => {
      // eslint-disable-next-line no-console
      console.error('OIDC callback handling failed', err);
    });
  });
}

export async function startSignIn(apiBaseUrl: string): Promise<void> {
  const codeVerifier = base64UrlEncode(randomBytes(32));
  const codeChallenge = base64UrlEncode(createHash('sha256').update(codeVerifier).digest());
  const state = base64UrlEncode(randomBytes(16));
  pendingPkce = { codeVerifier, state, createdAt: Date.now() };

  const authStart = new URL(`${apiBaseUrl.replace(/\/$/, '')}/v1/auth/oidc/login`);
  authStart.searchParams.set('redirect_uri', 'harvoost://auth/callback');
  authStart.searchParams.set('state', state);
  authStart.searchParams.set('code_challenge', codeChallenge);
  authStart.searchParams.set('code_challenge_method', 'S256');

  await shell.openExternal(authStart.toString());
}

async function handleProtocolUrl(url: string): Promise<void> {
  if (!url.startsWith('harvoost://auth/callback')) return;
  const parsed = new URL(url);
  const code = parsed.searchParams.get('code');
  const state = parsed.searchParams.get('state');
  if (!code || !state || !pendingPkce || pendingPkce.state !== state) {
    return;
  }
  // TODO(build-phase-followup): exchange { code, code_verifier } against apps/api
  // POST /v1/auth/oidc/callback and persist the returned session_token.
  pendingPkce = null;
}

export async function setBearerToken(token: string | null): Promise<void> {
  const k = getKeytar();
  if (!k) return;
  if (token) {
    await k.setPassword(SERVICE, ACCOUNT, token);
  } else {
    await k.deletePassword(SERVICE, ACCOUNT);
  }
}

export async function getBearerToken(): Promise<string | null> {
  const k = getKeytar();
  if (!k) return null;
  return k.getPassword(SERVICE, ACCOUNT);
}

function base64UrlEncode(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}
