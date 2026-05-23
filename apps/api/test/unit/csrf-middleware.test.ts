import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CsrfMiddleware } from '../../src/common/middleware/csrf.middleware';

// Finding 8 — CSRF Origin/X-Requested-With check.

function makeReq(opts: { method?: string; auth?: string; cookie?: string; origin?: string; xrw?: string } = {}) {
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

function makeEnv(allowed = ['https://app.harvoost.com', 'http://localhost:3000']) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { CORS_ALLOWED_ORIGINS: allowed.join(',') } as any;
}

describe('CsrfMiddleware', () => {
  let mw: CsrfMiddleware;
  let next: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mw = new CsrfMiddleware(makeEnv());
    next = vi.fn();
  });

  it('passes GET requests through (safe method)', () => {
    const res = makeRes();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mw.use(makeReq({ method: 'GET' }), res as any, next);
    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });

  it('passes Bearer-authenticated POST through (tray case)', () => {
    const res = makeRes();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mw.use(makeReq({ method: 'POST', auth: 'Bearer abc' }), res as any, next);
    expect(next).toHaveBeenCalled();
  });

  it('passes cookie-auth POST with allowed Origin', () => {
    const res = makeRes();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mw.use(
      makeReq({ method: 'POST', cookie: 'sess', origin: 'http://localhost:3000' }),
      res as any,
      next,
    );
    expect(next).toHaveBeenCalled();
  });

  it('passes cookie-auth POST with X-Requested-With: XMLHttpRequest', () => {
    const res = makeRes();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mw.use(
      makeReq({ method: 'POST', cookie: 'sess', xrw: 'XMLHttpRequest' }),
      res as any,
      next,
    );
    expect(next).toHaveBeenCalled();
  });

  it('rejects cookie-auth POST with bad Origin and no XRW header (403)', () => {
    const res = makeRes();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mw.use(
      makeReq({ method: 'POST', cookie: 'sess', origin: 'https://evil.example' }),
      res as any,
      next,
    );
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
  });

  it('passes through (auth guard rejects) when no credentials are present', () => {
    const res = makeRes();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mw.use(makeReq({ method: 'POST' }), res as any, next);
    expect(next).toHaveBeenCalled();
  });
});
