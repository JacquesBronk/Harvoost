import { describe, it, expect, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import { middleware } from '../middleware.js';

/**
 * Regression test for INC-001 — CSP nonce strategy.
 *
 * The middleware must:
 *  - Always emit a `Content-Security-Policy` header on the response.
 *  - Include a fresh `'nonce-<base64>'` token in the `script-src` directive.
 *  - Forward the SAME nonce on the upstream request as `x-nonce` (this is how Next.js
 *    auto-attaches it to its inline RSC flight-payload `<script>` tags).
 *  - Honour `NEXT_PUBLIC_API_BASE_URL` when building the `connect-src` directive.
 */

function makeRequest(url = 'http://localhost:3000/'): NextRequest {
  return new NextRequest(url);
}

function parseScriptSrc(csp: string): string[] {
  const directive = csp
    .split(';')
    .map((s) => s.trim())
    .find((s) => s.startsWith('script-src '));
  if (!directive) {
    throw new Error(`script-src directive not found in CSP: ${csp}`);
  }
  return directive.replace(/^script-src\s+/, '').split(/\s+/);
}

function parseConnectSrc(csp: string): string[] {
  const directive = csp
    .split(';')
    .map((s) => s.trim())
    .find((s) => s.startsWith('connect-src '));
  if (!directive) {
    throw new Error(`connect-src directive not found in CSP: ${csp}`);
  }
  return directive.replace(/^connect-src\s+/, '').split(/\s+/);
}

describe('CSP nonce middleware (INC-001 regression)', () => {
  const originalApiBase = process.env.NEXT_PUBLIC_API_BASE_URL;

  afterEach(() => {
    if (originalApiBase === undefined) {
      delete process.env.NEXT_PUBLIC_API_BASE_URL;
    } else {
      process.env.NEXT_PUBLIC_API_BASE_URL = originalApiBase;
    }
  });

  it('emits a Content-Security-Policy header on the response', () => {
    const res = middleware(makeRequest());
    expect(res.headers.get('Content-Security-Policy')).not.toBeNull();
  });

  it("includes a 'nonce-<base64>' token in the script-src directive", () => {
    const csp = middleware(makeRequest()).headers.get('Content-Security-Policy');
    expect(csp).not.toBeNull();
    const sources = parseScriptSrc(csp as string);
    const noncedSource = sources.find((s) => s.startsWith("'nonce-"));
    expect(noncedSource, `expected a nonce token in script-src; got: ${sources.join(' ')}`).toBeDefined();
    // Base64 chars only inside the nonce, non-empty.
    expect(noncedSource).toMatch(/^'nonce-[A-Za-z0-9+/=]+'$/);
  });

  it('forwards the same nonce on the request headers (x-nonce) as embedded in the CSP', () => {
    // The middleware sets `x-nonce` on the *upstream* request headers via
    // `NextResponse.next({ request: { headers } })`. Next exposes those on the response under
    // the `x-middleware-request-x-nonce` header name (its standard forwarding convention).
    const res = middleware(makeRequest());
    const csp = res.headers.get('Content-Security-Policy');
    expect(csp).not.toBeNull();
    const noncedSource = parseScriptSrc(csp as string).find((s) => s.startsWith("'nonce-"));
    expect(noncedSource).toBeDefined();
    const cspNonce = (noncedSource as string).replace(/^'nonce-/, '').replace(/'$/, '');

    const forwarded = res.headers.get('x-middleware-request-x-nonce');
    expect(forwarded, 'expected NextResponse.next() to forward x-nonce on request headers').toBe(cspNonce);
  });

  it("includes 'strict-dynamic' and 'wasm-unsafe-eval' in script-src", () => {
    const csp = middleware(makeRequest()).headers.get('Content-Security-Policy') as string;
    const sources = parseScriptSrc(csp);
    expect(sources).toContain("'strict-dynamic'");
    expect(sources).toContain("'wasm-unsafe-eval'");
    expect(sources).toContain("'self'");
  });

  it('uses the default apiOrigin in connect-src when NEXT_PUBLIC_API_BASE_URL is unset', () => {
    delete process.env.NEXT_PUBLIC_API_BASE_URL;
    const csp = middleware(makeRequest()).headers.get('Content-Security-Policy') as string;
    const sources = parseConnectSrc(csp);
    expect(sources).toContain("'self'");
    expect(sources).toContain('http://localhost:3001');
  });

  it('honours NEXT_PUBLIC_API_BASE_URL for connect-src', () => {
    process.env.NEXT_PUBLIC_API_BASE_URL = 'https://api.example.com';
    const csp = middleware(makeRequest()).headers.get('Content-Security-Policy') as string;
    const sources = parseConnectSrc(csp);
    expect(sources).toContain('https://api.example.com');
  });

  it('generates a fresh nonce on each invocation', () => {
    const csp1 = middleware(makeRequest()).headers.get('Content-Security-Policy') as string;
    const csp2 = middleware(makeRequest()).headers.get('Content-Security-Policy') as string;
    const n1 = parseScriptSrc(csp1).find((s) => s.startsWith("'nonce-"));
    const n2 = parseScriptSrc(csp2).find((s) => s.startsWith("'nonce-"));
    expect(n1).toBeDefined();
    expect(n2).toBeDefined();
    expect(n1).not.toBe(n2);
  });
});
