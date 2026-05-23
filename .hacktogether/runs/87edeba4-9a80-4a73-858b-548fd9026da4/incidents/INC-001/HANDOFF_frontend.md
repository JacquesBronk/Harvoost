---
phase: incidents/INC-001
agent: frontend-dev
started: 2026-05-23T10:30:00Z
finished: 2026-05-23T10:40:00Z
status: complete
---

# Summary

Implemented the Next.js 14 per-request CSP nonce strategy in `apps/web/` to fix the infinite-spinner hydration hang reported in INC-001. A new Edge-runtime `middleware.ts` generates a fresh base64 nonce per request, writes a `Content-Security-Policy` header with `script-src 'self' 'nonce-<NONCE>' 'strict-dynamic' 'wasm-unsafe-eval'` (and the other unchanged directives), forwards `x-nonce` on the upstream request via `NextResponse.next({ request: { headers } })`, and emits the CSP on the response. The static `Content-Security-Policy` entry was removed from `next.config.mjs:headers()`; the other three static security headers (`X-Frame-Options`, `Referrer-Policy`, `X-Content-Type-Options`) remain there. A regression test (`__tests__/middleware.test.ts`) covers the four required cases plus three robustness checks. `apps/web` did not previously have a test runner; I added a minimal `vitest.config.ts` plus a `test` script and a `vitest` devDependency so the regression test can run — no other test infra changes.

# Files touched
- `apps/web/middleware.ts` (new, 74 lines) — per-request nonce middleware + matcher config.
- `apps/web/next.config.mjs` (modified, 49 → 38 lines) — removed the per-request `Content-Security-Policy` header and the now-unused `apiOrigin` const; kept the other three static security headers.
- `apps/web/__tests__/middleware.test.ts` (new, 115 lines) — vitest regression suite for the CSP nonce contract.
- `apps/web/vitest.config.ts` (new, 8 lines) — minimal vitest config (Node env, include `__tests__/**/*.test.ts` and `src/**/*.test.ts`).
- `apps/web/package.json` (modified) — added `"test": "vitest run"` script and `vitest@^2.1.0` devDependency. Required to make the regression test runnable; matches the convention used by `apps/api` and the `packages/*` workspaces.
- `apps/web/app/layout.tsx` — **NOT modified**. Verified there are no raw `<script>` tags or `next/script` imports anywhere in `apps/web/app/**` or `apps/web/src/**`. Next.js auto-propagates the nonce to its own inline RSC scripts when it sees `x-nonce` on the forwarded request headers, so no manual `headers().get('x-nonce')` plumbing is needed.

# Final CSP header (template form)

```
default-src 'self'; script-src 'self' 'nonce-<NONCE>' 'strict-dynamic' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self' <apiOrigin>; frame-ancestors 'none'; base-uri 'self'; form-action 'self'
```

- `<NONCE>` is `Buffer.from(crypto.randomUUID()).toString('base64')` per request (length ~48 chars).
- `<apiOrigin>` is `process.env.NEXT_PUBLIC_API_BASE_URL ?? 'http://localhost:3001'`.

# Verification evidence

- `cd apps/web && pnpm test` → **7/7 passed** in 9.0 s on the new `__tests__/middleware.test.ts` suite. The seven cases assert:
  1. response carries a `Content-Security-Policy` header;
  2. `script-src` contains a `'nonce-<base64>'` token (regex-matched);
  3. the forwarded request header `x-nonce` (exposed via `x-middleware-request-x-nonce` on the `NextResponse`) equals the nonce embedded in the CSP — confirms Next.js will see the same nonce both on the request (for RSC inline-script propagation) and on the response (for browser enforcement);
  4. `'strict-dynamic'`, `'wasm-unsafe-eval'`, and `'self'` are all present in `script-src`;
  5. `connect-src` includes the default `http://localhost:3001` when `NEXT_PUBLIC_API_BASE_URL` is unset;
  6. `connect-src` honours an override URL;
  7. consecutive invocations produce distinct nonces (proves it's not a build-time constant).
- `cd apps/web && pnpm typecheck` → clean (`tsc --noEmit` exits 0).
- `pnpm test` from repo root → my new tests pass cleanly. There is **one pre-existing failure** in `packages/shared` (`RbacScopeService — throws RbacError on empty requesterId`) that exists on `main` HEAD before any of my changes (verified by `git stash && pnpm --filter @harvoost/shared test` showing the same failure). It is **unrelated to INC-001** and out of scope.

# What downstream agents need to know

- **Home-page caching impact:** Per the dispatch instructions, this is intended. Adding `middleware.ts` forces `/` to render per request (the `x-nextjs-cache: HIT` that previously appeared on the static prerender goes away). No `dynamic = 'force-static'` workaround was added.
- **`apps/web` now has a vitest setup.** This is new test infra. The repo-level `pnpm test` (which runs `turbo run test`) will now also execute `@harvoost/web#test` because turbo discovers the `test` script. The web suite currently has only this one regression test file; the 375 pre-existing tests live in other packages and are unaffected.
- **Module-resolution quirk:** `apps/web/tsconfig.json` uses `moduleResolution: bundler` (not NodeNext as the source comment suggests), but the source convention is still `.js` import suffixes (Next.js's webpack `extensionAlias` resolves `.js` → `.ts`/`.tsx`). The test file imports the middleware as `import { middleware } from '../middleware.js'` to match. Vitest resolves this via its default Vite resolver, which honors `extensionAlias` only indirectly — but in this case the `.js` suffix on an existing `.ts` file is silently resolved by Vite/Vitest's default module resolution. Confirmed working.
- **Edge-runtime `Buffer` and `crypto`:** Both globally available in Next 14's Edge Runtime. No `export const runtime = 'nodejs'` opt-in needed.
- **`'strict-dynamic'` semantics:** Once a nonced script runs, any script *it* loads is also allowed without needing its own nonce. This is what the Next.js docs recommend for app-router CSP and is what makes the chunked client bundles work without listing each chunk in `script-src`.
- **Matcher pattern:** Excludes `api`, `_next/static`, `_next/image`, `favicon.ico`, and any path containing a file extension (covers `.png/.svg/.css/.ico/...`). Also skips `next-router-prefetch` and `purpose: prefetch` requests so we don't burn nonces on link-prefetch RSC fetches — standard from the Next.js CSP docs.
- **Pre-existing footgun (out of scope):** `apps/web/src/lib/env.ts` falls back to `http://localhost:3001` if `NEXT_PUBLIC_API_BASE_URL` is missing at runtime. As noted in `ROOT_CAUSE.md` H1, the Dockerfile.web does not bake this var as a build arg. Not part of this fix; flagged here only because the parallel devops agent is editing Dockerfile.web and may want to address it.
- **Pre-existing test failure in `packages/shared`:** `RbacScopeService > throws RbacError on empty requesterId` fails on `main` before this fix. Not related to CSP. Should be triaged separately.

# Open questions / unknowns

- None.

# Verifier checklist

After this fix is applied alongside the devops agent's Dockerfile/compose changes:

1. `docker compose down && docker compose up -d --build`
2. `curl -sI http://localhost:3000/ | grep -i content-security-policy` → should contain `script-src 'self' 'nonce-<some-base64>' 'strict-dynamic' 'wasm-unsafe-eval'`. The nonce should change on every request.
3. `curl -s http://localhost:3000/ | grep -oE '<script nonce="[^"]+"' | head -3` → should show inline scripts carrying a `nonce="..."` attribute that matches the CSP nonce.
4. Open `http://localhost:3000/` in a browser → spinner appears briefly, then page redirects to `/login`. Browser console should have zero `Refused to execute inline script` errors.
5. `cd apps/web && pnpm test` → 7/7 pass.
6. `pnpm typecheck` → clean across the monorepo.
