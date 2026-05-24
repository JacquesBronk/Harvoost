---
phase: 04-build
agent: backend-dev
started: 2026-05-24
finished: 2026-05-24
status: complete
---

# Summary
Fixed the over-aggressive rate limit (INC-005 / issue #8) in the API lane. Root cause was confirmed empirically against the installed `@nestjs/throttler@6.5.0` source: the guard iterates EVERY bucket declared in `forRoot` on EVERY route, so the smallest (`auth` 5/60s) capped all reads. Implemented Fix A1 (make `auth`/`chatbot` opt-IN), Fix B (per-principal `getTracker` + right-size `global` to 1000/60s), and the backend half of Fix D (CORS-expose the Retry-After headers). Routine reads are now governed ONLY by the per-principal `global` bucket; the 5/60s `auth` brute-force cap on login/callback (INC-003) and `/me`'s skip are preserved. All gates pass: typecheck clean, api unit suite 304/304 passing.

# Files touched
- apps/api/src/common/throttler/principal-throttler.guard.ts (new) — custom guard: per-principal `getTracker` (`user:<id>` / `ip:<addr>`) + opt-IN enforcement of `auth`/`chatbot` buckets via per-bucket `handleRequest` override.
- apps/api/src/app.module.ts (modified) — `global` bucket 300 → 1000/60s; swapped stock `ThrottlerGuard` → `PrincipalThrottlerGuard` (guard order preserved: Bearer → Roles → Throttler); added explanatory comments incl. in-memory-store caveat.
- apps/api/src/main.ts (modified) — CORS `exposedHeaders: ['Retry-After-global', 'Retry-After-auth', 'Retry-After']`.
- apps/api/test/unit/principal-throttler-guard.test.ts (new) — 12 tests: opt-in exemption for reads, enforcement on login/callback/chatbot, `/me` skip, `global` always-on, per-principal `getTracker`.
- apps/api/test/unit/throttler.test.ts (modified) — added 3 INC-005 metadata regression tests (reads carry no `auth`/`chatbot` limiter metadata).

# What downstream agents need to know

## A1 mechanism chosen: option (ii), NOT option (i) — and WHY
I verified empirically against the installed v6.5.0 source (`node_modules/.pnpm/@nestjs+throttler@6.5.0.../dist/throttler.guard.js`). The guard's `canActivate` loops ONLY over `this.throttlers`, which is populated in `onModuleInit` from the `forRoot` array. **A route-level `@Throttle({ name: {...} })` whose name is NOT in `forRoot` is never iterated, so it is never enforced.** Therefore plan option (i) (leave only `global` in `forRoot` and define `auth`/`chatbot` purely via decorators) is IMPOSSIBLE in v6.5.0 — the decorated buckets would simply never fire.

I used option (ii) but in its least-error-prone form (no per-controller `@SkipThrottle` sprawl): all three buckets stay in `forRoot`, and the new `PrincipalThrottlerGuard` overrides the per-bucket `handleRequest` hook to make `auth` and `chatbot` opt-IN. For a bucket in `OPT_IN_BUCKETS = ['auth','chatbot']`, the guard returns `true` (allowed, uncounted) UNLESS the route carries explicit `@Throttle` limit metadata for that bucket (read via the SAME `THROTTLER:LIMIT<name>` reflector key the stock guard uses), and an explicit `@SkipThrottle({<name>:true})` still wins. `global` is never opt-in, so it always runs — it is the only app-wide limit. The existing `@Throttle({auth})` on `AuthController` and `@Throttle({chatbot})` on `ChatbotController.postMessage` were left untouched and now scope correctly; `/me`'s `@SkipThrottle({auth:true})` still works.

## CONFIRMED on-the-wire 429 header for the global bucket: `Retry-After-global`
Verified with a runtime probe driving the real `super.handleRequest` with a blocked `global` result — it called `res.header('Retry-After-global', 60)`. This matches the v6.5.0 source: `getThrottlerSuffix(name) => name === 'default' ? '' : `-${name}``. So:
- A throttled READ that 429s (blocked by `global`) carries **`Retry-After-global: <seconds>`** — matches the pinned cross-lane contract exactly. No deviation; frontend-dev's fallback list is correct as specified.
- A throttled login/callback that 429s (blocked by `auth`) carries **`Retry-After-auth: <seconds>`**.
- CORS now exposes all three (`Retry-After-global`, `Retry-After-auth`, `Retry-After`).

## req.user shape confirmed
`BearerAuthGuard` sets `req.user = { userId, email, roles }` (apps/api/src/auth/bearer-auth.guard.ts:90,106; lookupUser returns that exact shape). `getTracker` reads `req.user.userId`. Guard order in app.module.ts puts `BearerAuthGuard` before `PrincipalThrottlerGuard`, so `req.user` is populated when `getTracker` runs.

## 429 envelope unchanged (deliberate)
I did NOT override `throwThrottlingException`. The stock `ThrottlerException` (HttpException 429) flows through the existing `HttpExceptionFilter`, which maps status 429 → `{ code: "RATE_LIMITED", message }` via `inferCode(429)`. The envelope is byte-for-byte what it was before — no request/response shape change, honoring the no-contract-change constraint.

## Budget / storage decision (for the Decision log)
Per-principal `global` budget set to **1000 / 60_000ms** as instructed. Storage is the in-memory `ThrottlerStorage` (forRoot default) — single-process only, NOT shared across API instances. A Redis-backed `ThrottlerStorage` is a documented v1.1 follow-up before horizontal scaling (noted in code comments in both the guard and app.module.ts).

# Open questions / unknowns
- Repo-wide lint is broken INDEPENDENTLY of this change: ESLint v9.39.4 is installed but the repo still uses legacy `.eslintrc.cjs` (apps/api/.eslintrc.cjs, root .eslintrc.cjs), which ESLint v9 no longer reads ("couldn't find an eslint.config.(js|mjs|cjs) file"). This affects the entire repo, not my files. I followed existing style conventions; typecheck + tests are the authoritative gates and both pass. Flag for a separate toolchain fix if lint is required in CI.
- No further unknowns. Per-IP-collision, /me, login/callback, and chatbot edge cases are all covered by tests.

# Verification evidence
- `pnpm --filter @harvoost/api typecheck` → clean (exit 0, no tsc errors).
- `pnpm --filter @harvoost/api test` → **39 files, 304 tests, 0 failed** (baseline before my change was 289 passed / 0 failed; I added 15 tests: 12 in principal-throttler-guard.test.ts + 3 in throttler.test.ts — all pass).
- The task mentioned one known pre-existing failure (`RbacScopeService > throws RbacError on empty requesterId`): that test lives in `packages/shared` (`@harvoost/shared`), NOT in `@harvoost/api`, so it does not appear in this suite. The api suite was already 0-failure at baseline and remains 0-failure. I introduced no new failures.
- Wire probe (temporary, since removed): blocked `global` bucket emits `res.header('Retry-After-global', 60)` — header name confirmed.
- The `[AuditService] audit.record.failed` ERROR line in test output is an existing test exercising a failure path (present at baseline), not a test failure.
