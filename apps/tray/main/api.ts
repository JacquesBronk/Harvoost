// HTTP client used by the Electron main process. The renderer never makes
// direct HTTP calls — see ARCHITECTURE.md § Electron CORS strategy r2.

import { randomUUID } from 'node:crypto';
import { getBearerToken } from './auth.js';

const API_BASE_URL = process.env.HARVOOST_API_URL ?? 'http://localhost:3001';

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

export async function apiCall<T = unknown>(
  path: string,
  options: ApiCallOptions = {},
): Promise<ApiResult<T>> {
  const { method = 'GET', body, headers = {}, idempotent } = options;
  const token = await getBearerToken();

  const finalHeaders: Record<string, string> = {
    Accept: 'application/json',
    ...headers,
  };
  if (token) finalHeaders.Authorization = `Bearer ${token}`;
  if (body !== undefined) finalHeaders['Content-Type'] = 'application/json';
  if (idempotent && !finalHeaders['Idempotency-Key']) {
    finalHeaders['Idempotency-Key'] = randomUUID();
  }

  try {
    const response = await fetch(
      `${API_BASE_URL.replace(/\/$/, '')}${path.startsWith('/') ? path : `/${path}`}`,
      {
        method,
        headers: finalHeaders,
        body: body !== undefined ? JSON.stringify(body) : undefined,
      },
    );
    const text = await response.text();
    let payload: unknown = undefined;
    if (text) {
      try {
        payload = JSON.parse(text);
      } catch {
        // non-JSON
      }
    }
    if (!response.ok) {
      const env = payload && typeof payload === 'object' ? (payload as Record<string, unknown>) : {};
      return {
        ok: false,
        status: response.status,
        error: {
          code: typeof env.code === 'string' ? env.code : 'UNKNOWN_ERROR',
          message: typeof env.message === 'string' ? env.message : `HTTP ${response.status}`,
          details: env.details,
        },
      };
    }
    return { ok: true, status: response.status, data: payload as T };
  } catch (err) {
    return {
      ok: false,
      status: 0,
      error: {
        code: 'NETWORK_ERROR',
        message: err instanceof Error ? err.message : 'Network error',
      },
    };
  }
}

export const apiBaseUrl = API_BASE_URL;
