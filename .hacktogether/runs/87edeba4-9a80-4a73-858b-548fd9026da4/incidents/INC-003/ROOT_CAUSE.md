# INC-003 — ROOT_CAUSE (auth /me request loop trips the 5/60s throttle)

GitHub issue: #3. **Status: CONFIRMED.** Live browser reproduction confirms (does NOT
revise) the pre-diagnosed two-defect root cause. Both defects A and B were observed
with live network evidence against the running stack.

## Symptoms
After a real Keycloak sign-in as Alice, the browser fires a storm of
`GET /v1/auth/me` requests; the API returns `429 {"code":"RATE_LIMITED","message":"ThrottlerException: Too Many Requests"}`.
The UI is wedged on the "Loading Harvoost" spinner and ping-pongs toward `/login`.
Unusable until the 60s window clears.

## Live evidence (Playwright `chromium-live`, real Keycloak round-trip, single Alice session)
Repro: `incidents/INC-003/repro/auth-me-loop.repro.spec.ts` (full log: `repro/run-3.log`,
trimmed: `repro/run-3.trimmed.log`). Test PASSED (assertion = "at least one 429 on /me").

- **909 `GET /v1/auth/me` requests in 11.4s** — 4× `200`, then **905× `429`**.
- **The 5th `/me` request is the first `429`** (t=7681ms). The bucket math is exact:
  `oidc/login` POST (201, t=134ms) + `oidc/callback` POST (201, t=538ms) + 3× `/me` 200
  = 5 tokens consumed → the next `/me` 429s. **`/me`, `login`, and `callback` share one bucket.**
- After the first 429 the storm has **no backoff**: ~750+ requests in ~3.7s, roughly one
  every 4–5 ms.
- Main-frame navigations show repeated `/timesheets` loads and the final body text is
  literally `"Loading Harvoost"` — the spinner-wedged, unusable state from the issue.
- 429 envelope/headers (isolated via repeated `oidc/login` POSTs, same bucket):
  body `{"code":"RATE_LIMITED","message":"ThrottlerException: Too Many Requests"}`;
  header is **`Retry-After-auth: 54`** (NestJS per-named-bucket header) — there is **no plain
  `Retry-After`** header. (Frontend backoff must read `Retry-After-auth`, see HOTFIX_PLAN.)
- Control: **10 UNAUTHENTICATED `/me` hits all returned `401`, never `429`** — the auth guard
  short-circuits before the throttler counts, which is exactly why the limit "looks fine in
  isolation" and only bites authenticated sessions.

## Root Cause — two compounding defects (both confirmed)

### B. Backend (the trigger)
`apps/api/src/auth/auth.controller.ts:56` puts `@Throttle({ auth: { ttl: 60_000, limit: 5 } })`
on the **`@Controller('v1/auth')` class**, so it covers `@Get('me')` (line 334) along with
`oidc/login` and `oidc/callback`. The `auth` bucket is **5/60s** (`apps/api/src/app.module.ts:40`).
`/me` is hit on every page load/remount, so a normal session burns the 5-token brute-force
budget within seconds and `/me` starts 429-ing. Login + callback already consume 2 of the 5
on every fresh sign-in, leaving only 3 `/me` calls before the lockout.

### A. Frontend (the amplifier)
`apps/web/src/lib/auth.ts` `useCurrentUser` (lines 24–32) maps **only 401/403 → `null`**
(line 28); any other error — **429**, 5xx, network — **re-throws** (line 31), so the query
enters ERROR state with `data === undefined`. `retry: false` (line 35) means no backoff.
Consumers treat absent/undefined user as "logged out":
- `apps/web/app/page.tsx:14-18` → `router.replace('/login')` on any falsy `user`.
- `apps/web/src/components/AppShell.tsx:98` `if (!user) return <>{children}</>` (drops the shell).
- page guards (`timesheets/page.tsx`, `dashboard`, `schedule`, `settings`, `rbac.ts`) all key
  off `useCurrentUser().data` being falsy.
- `apps/web/src/lib/api-client.ts:112-121` throws an `ApiError` (status 429) for any non-2xx,
  so the 429 reaches `useCurrentUser`'s catch and is re-thrown.

The redirect + remount re-mounts the React tree → `useCurrentUser` refetches `/me` (error
state is never "fresh", so `staleTime` does not suppress it) → no backoff → loop. One backend
429 becomes a 900-request storm.

## Verification
- Live repro PASSED: `total429 > 0` (905 observed). See `repro/run-3.log`.
- Unauthenticated-`/me` control: 10/10 returned 401, never 429 (guard short-circuits the throttler).
- 429 header confirmed `Retry-After-auth: 54` (no plain `Retry-After`).
- No app source was modified (constraint: debugger does not implement the fix).

## Prevention Recommendation
- Backend: keep `/me` off brute-force buckets by construction; add a unit/e2e regression that
  authenticated `/me` is NOT on the 5/60s `auth` bucket (assert no 429 across >5 rapid authed hits).
- Frontend: a `useCurrentUser` unit test that a 429/5xx/network error does NOT yield `data === null`
  and does NOT drive a `/login` redirect; an e2e that a transient 429 backs off and recovers
  without a request storm. Lint/convention: redirect-to-login ONLY on `data === null`, never on
  error/undefined.
