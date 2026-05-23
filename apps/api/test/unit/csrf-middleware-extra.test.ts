import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CsrfMiddleware } from '../../src/common/middleware/csrf.middleware';

// Finding 8 — complementary edge-cases not covered by the base csrf-middleware.test.ts.
// The base test verifies the happy paths and the "bad Origin" rejection. This
// extension covers ambiguous request shapes that a real CSRF attacker can produce
// from a non-browser context (curl, attacker-controlled fetch).

function makeReq(opts: {
  method?: string;
  auth?: string;
  cookie?: string;
  origin?: string;
  xrw?: string;
} = {}) {
  return {
    method: opts.method ?? 'POST',
    headers: {
      authorization: opts.auth,
      origin: opts.origin,
      'x-requested-with': opts.xrw,
    },
    cookies: opts.cookie ? { harvoost_session: opts.cookie } : {},
    path: '/v1/leave/requests',
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

function makeRes() {
  const json = vi.fn();
  const status = vi.fn(() => ({ json }));
  return { status, json };
}

function makeEnv() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { CORS_ALLOWED_ORIGINS: 'https://app.harvoost.com,http://localhost:3000' } as any;
}

describe('CsrfMiddleware — additional edge cases (Finding 8)', () => {
  let mw: CsrfMiddleware;
  let next: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mw = new CsrfMiddleware(makeEnv());
    next = vi.fn();
  });

  it('rejects cookie-auth POST with NEITHER Origin NOR X-Requested-With (403)', () => {
    // The canonical CSRF attack shape: an attacker page submits a form, the
    // browser sends the session cookie automatically (SameSite=Lax allows
    // top-level navigations), but does NOT set Origin on form POSTs in some
    // older browsers AND does NOT set X-Requested-With without explicit JS.
    const res = makeRes();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mw.use(makeReq({ method: 'POST', cookie: 'sess' }), res as any, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'CSRF_FAILURE' }),
    );
  });

  it('rejects cookie-auth PATCH with wrong Origin and no XRW (403)', () => {
    const res = makeRes();
    mw.use(
      makeReq({
        method: 'PATCH',
        cookie: 'sess',
        origin: 'https://attacker.example',
      }),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      res as any,
      next,
    );
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
  });

  it('rejects cookie-auth DELETE with wrong Origin and no XRW (403)', () => {
    const res = makeRes();
    mw.use(
      makeReq({
        method: 'DELETE',
        cookie: 'sess',
        origin: 'https://evil.example',
      }),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      res as any,
      next,
    );
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
  });

  it('passes HEAD requests through (safe method)', () => {
    const res = makeRes();
    mw.use(makeReq({ method: 'HEAD' }), res as any, next);
    expect(next).toHaveBeenCalled();
  });

  it('passes OPTIONS preflight through (safe method)', () => {
    const res = makeRes();
    mw.use(makeReq({ method: 'OPTIONS' }), res as any, next);
    expect(next).toHaveBeenCalled();
  });

  it('accepts X-Requested-With case-insensitively (xmlhttprequest also OK)', () => {
    const res = makeRes();
    mw.use(
      makeReq({ method: 'POST', cookie: 'sess', xrw: 'xmlhttprequest' }),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      res as any,
      next,
    );
    expect(next).toHaveBeenCalled();
  });

  it('error envelope shape matches { code: "CSRF_FAILURE", message: string }', () => {
    const res = makeRes();
    mw.use(
      makeReq({ method: 'POST', cookie: 'sess', origin: 'https://evil.example' }),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      res as any,
      next,
    );
    const body = (res.json.mock.calls[0]?.[0] ?? {}) as Record<string, unknown>;
    expect(body.code).toBe('CSRF_FAILURE');
    expect(typeof body.message).toBe('string');
    expect((body.message as string).length).toBeGreaterThan(0);
  });
});
