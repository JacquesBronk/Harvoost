import { NextRequest, NextResponse } from 'next/server';

/**
 * Per-request CSP nonce middleware.
 *
 * Implements the Next.js 14 recommended pattern:
 * https://nextjs.org/docs/app/building-your-application/configuring/content-security-policy
 *
 * Generates a fresh base64 nonce on every request and writes it into a `Content-Security-Policy`
 * header. When Next.js renders the page, it auto-discovers the nonce from the forwarded request
 * header (via `NextResponse.next({ request: { headers } })`) and attaches it to every inline RSC
 * `<script>` it emits, so the browser permits the flight-payload scripts that drive hydration.
 *
 * The `'strict-dynamic'` token is included per the Next.js docs — it allows scripts loaded by
 * trusted nonced scripts to also run, which is required by Next's hydration pipeline.
 *
 * Runs on the Edge Runtime by default. Both `Buffer` and `crypto.randomUUID()` are available
 * in Next 14's Edge Runtime, so no `nodejs` runtime opt-in is needed.
 */
export function middleware(request: NextRequest): NextResponse {
  const nonce = Buffer.from(crypto.randomUUID()).toString('base64');
  const apiOrigin = process.env.NEXT_PUBLIC_API_BASE_URL ?? 'http://localhost:3001';

  const cspDirectives = [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic' 'wasm-unsafe-eval'`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    `connect-src 'self' ${apiOrigin}`,
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ];
  const cspHeader = cspDirectives.join('; ');

  // Forward the nonce and CSP to Next.js's own rendering pipeline by setting them on the
  // *request* headers. Next.js reads `x-nonce` and propagates it to inline RSC scripts.
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set('x-nonce', nonce);
  requestHeaders.set('Content-Security-Policy', cspHeader);

  const response = NextResponse.next({
    request: {
      headers: requestHeaders,
    },
  });

  // Also send the CSP to the browser on the response so the policy is enforced client-side.
  response.headers.set('Content-Security-Policy', cspHeader);

  return response;
}

export const config = {
  matcher: [
    /*
     * Match all request paths except:
     * - api routes (none in this app, but reserved by Next)
     * - _next/static (static build assets)
     * - _next/image (image optimisation API)
     * - favicon.ico
     * - any path that contains a file extension (e.g. *.png, *.svg, *.css, *.ico)
     *
     * Pattern lifted from the Next.js CSP nonce docs.
     */
    {
      source: '/((?!api|_next/static|_next/image|favicon.ico|.*\\..*).*)',
      missing: [
        { type: 'header', key: 'next-router-prefetch' },
        { type: 'header', key: 'purpose', value: 'prefetch' },
      ],
    },
  ],
};
