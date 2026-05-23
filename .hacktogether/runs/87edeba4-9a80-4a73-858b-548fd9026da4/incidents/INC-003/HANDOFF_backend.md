---
phase: 04-build
agent: backend-dev
started: 2026-05-23
finished: 2026-05-23
status: complete
---

# Summary
INC-003 Lane B (backend, GitHub issue #3): took `GET /v1/auth/me` off the 5/60s
brute-force `auth` throttle bucket so a normal authenticated session no longer
burns the budget within seconds and 429s. Added `@SkipThrottle({ auth: true })`
on the `me()` method only — it skips ONLY the named `auth` bucket, so `/me`
falls back to the global 300/60s bucket. The class-level
`@Throttle({ auth: { ttl: 60_000, limit: 5 } })` is left untouched, so
`oidc/login` + `oidc/callback` keep their 5/60s brute-force protection. Added a
metadata-level regression test (the established harness pattern) asserting the
new SKIP metadata on `me()` and that login/callback are NOT skipped.

# Files touched
- `apps/api/src/auth/auth.controller.ts` (modified)
- `apps/api/test/unit/throttler.test.ts` (modified — added INC-003 regression block)

## Exact diff — `apps/api/src/auth/auth.controller.ts`

Import (line 2):
```diff
-import { Throttle } from '@nestjs/throttler';
+import { Throttle, SkipThrottle } from '@nestjs/throttler';
```

Decorator on `me()` (above `@Get('me')`, formerly line 334):
```diff
   // directly without a null guard).
+  //
+  // INC-003: /me is hit on every page load/remount. The class-level
+  // @Throttle({ auth: { ttl: 60_000, limit: 5 } }) brute-force bucket (for
+  // oidc/login + oidc/callback) MUST NOT cover /me, or a normal authenticated
+  // session burns the 5-token budget within seconds and starts returning 429.
+  // Skip ONLY the named `auth` bucket here; /me still falls back to the global
+  // 300/60s bucket (app.module.ts). oidc/login + oidc/callback keep the 5/60s
+  // brute-force protection (they are not decorated with @SkipThrottle).
+  @SkipThrottle({ auth: true })
   @Get('me')
   async me(
```

UNCHANGED (verified still present, line 56):
```ts
@Throttle({ auth: { ttl: 60_000, limit: 5 } })
@Controller('v1/auth')
export class AuthController {
```
`apps/api/src/app.module.ts` — NOT modified (bucket defs lines 38–42 left intact:
`chatbot` 30/60s, `auth` 5/60s, `global` 300/60s).

# Tests added — `apps/api/test/unit/throttler.test.ts`
New `describe('Throttle/SkipThrottle — INC-003 (/me off the auth brute-force bucket)')`
with 4 cases, plus a `readNamedSkip()` helper reading the `THROTTLER:SKIP<name>`
metadata key (same key shape as the existing `THROTTLER:LIMIT`/`THROTTLER:TTL`
reads). Cases:
1. `me()` carries `@SkipThrottle({ auth: true })` — `THROTTLER:SKIPauth === true`
   on `AuthController.prototype.me`. (= /me is removed from the 5/60s `auth`
   bucket; >5 rapid authed /me hits cannot 429 on `auth`.)
2. `me()` does NOT skip the `global`/`default` buckets — `/me` still falls back
   to global 300/60s (no SKIP metadata for those names).
3. `me()` does NOT itself carry the `auth` limiter (no `THROTTLER:LIMITauth` on
   the method) — the 5/60s cap is class-level only.
4. `oidcLogin` + `oidcCallback` have NO `SKIP:auth` metadata, AND the class still
   declares `auth` limit=5 / ttl=60_000 — i.e. login/callback STILL 429 after 5
   hits (brute-force protection intact).

## Why metadata-level (not live e2e) for the throttle assertion
Per dispatch guidance, the metadata assertion is the sanctioned approach when a
full e2e throttle test is impractical. The runtime `ThrottlerGuard` (v6.5.0)
derives behavior directly from exactly this metadata: for each named bucket it
calls `reflector.getAllAndOverride('THROTTLER:SKIP'+name, [handler, classRef])`
and, when truthy, `continue`s past that bucket WITHOUT consulting its LIMIT/TTL.
So `SKIP:auth=true` on `me()` provably bypasses the `auth` bucket while leaving
`global` in force — metadata == behavior. I confirmed this by reading
`@nestjs/throttler@6.5.0` `throttler.decorator.js` (SkipThrottle defines
`THROTTLER:SKIP<name>`) and `throttler.guard.js` (the `getAllAndOverride` +
`continue` logic). A live e2e on `/me` would additionally require a running
Postgres (the `TEST_AUTH_BYPASS` path still does a real `users`/`user_roles`
lookup in `bearer-auth.guard.ts`), making it environment-dependent; the metadata
test is deterministic and DB-independent.

# What downstream agents need to know
- Contract for `/v1/auth/me` is UNCHANGED (same response shape, same auth guard).
  Frontend Lane A (auth.ts/api-client.ts/page.tsx/AppShell.tsx) is still
  required — backend alone does not fix the loop; it only stops `/me` from
  consuming/exhausting the brute-force bucket. After Lane B, an authenticated
  `/me` storm hits the global 300/60s ceiling instead of the 5/60s `auth` one,
  but the frontend must still stop the storm (backoff + don't redirect on
  transient error).
- `oidc/login` and `oidc/callback` 429 behavior is INTENTIONALLY unchanged
  (5/60s). The frontend should keep honoring `Retry-After-auth` on those POSTs.
- No new dependencies. No migrations. No app.module.ts changes. No `.github/`
  changes. Did not touch reporting (#4) or timesheets timer (#5).
- Rollback: delete the `@SkipThrottle({ auth: true })` line + its comment above
  `me()` and drop `SkipThrottle` from the import. Fully isolated/additive.

# Open questions / unknowns
- None.

# Verification evidence
- `pnpm --filter @harvoost/api typecheck` → PASS (tsc --noEmit, no output/errors).
- `pnpm exec vitest run test/unit/throttler.test.ts` → 8 passed (8) — 4 pre-existing
  + 4 new INC-003 cases.
- `pnpm --filter @harvoost/api test` → 31 test files passed, 235 tests passed, 0 failed.
  `auth-me.test.ts` (4 tests) still green → `/me` response contract unchanged.
  The known pre-existing `RbacScopeService` failure did NOT surface in the api
  unit filter (api package is fully green).
