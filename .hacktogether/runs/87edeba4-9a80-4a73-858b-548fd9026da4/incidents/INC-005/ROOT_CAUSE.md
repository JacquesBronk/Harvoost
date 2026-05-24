# INC-005 — ROOT_CAUSE (debugger: reproduce + confirm)

GitHub issue #8 — "Aggressive global rate limit: normal navigation/refresh trips 429 RATE_LIMITED across all endpoints."
Mode: directed hotfix. Live repro via Playwright `chromium-live` against the running Docker stack (`http://localhost:3000`, API `:3001`), signed in as `alice@harvoost.local` through real Keycloak.

## Verdict
**Confirmed that normal navigation trips 429 RATE_LIMITED across multiple endpoints — but the diagnosis is materially WRONG about WHICH bucket bites and how big the budget effectively is.** The limit is far more aggressive than the report states. Two of three pre-diagnosed factors are confirmed with a correction; the headline "300/60s global bucket" framing is incorrect. Confidence: **high** (multiple live runs + throttler source read).

## Symptoms (observed live)
- On a **completely fresh 60s window**, a single routine read endpoint (`GET /v1/projects`) returns **429 starting at the 5th request** (4×200 then 429…). See `repro/run-2-probe.log`.
- A single authed landing on `/timesheets` fires **7 `/v1` requests**; a landing + 4 client navigations fires **21**. In one paced run, ordinary navigation alone produced **2 organic 429s** (`/v1/time-entries/running`, `/v1/time-entries`) without any synthetic load. See `repro/run-3.log` (T1).
- After draining, normal UI reads return 429 across **multiple distinct endpoints at once** (`/v1/time-entries/running`, `/v1/projects`, …), matching the "many panels fail" report. See `repro/run-1.log` / `run-3.log` (T2).
- Envelope is `{code:"RATE_LIMITED"}`, status 429.

## Factor-by-factor

### Factor 1 — bucket too small for fan-out → **CONFIRMED, but the binding bucket is `auth` 5/60s, NOT `global` 300/60s** (CORRECTION)
`apps/api/src/app.module.ts:40-44` declares THREE *global* named throttlers via `ThrottlerModule.forRoot([...])`: `chatbot` 30/60s, `auth` 5/60s, `global` 300/60s. In `@nestjs/throttler` v6 (installed: **6.5.0**), **every named throttler in `forRoot` is enforced on EVERY route** unless that route names it in `@SkipThrottle`. The guard iterates all three buckets per request (`throttler.guard.js` `canActivate` → loop over `this.throttlers`) and 429s on the FIRST that blocks. The smallest bucket therefore binds: **`auth` 5/60s caps every route that does not `@SkipThrottle({auth:true})`**. Only `GET /v1/auth/me` skips it (auth.controller.ts:342). So the *effective* read limit for the whole app is **5 requests per 60s per route per IP**, not 300. The `global` 300 bucket almost never bites. Live proof: `/v1/projects` 429s at request #5 on a clean window (`run-2-probe.log`). The per-page fan-out (7 reads, 6 of them NOT skipping auth) blows the 5-token budget on the very first or second page load.

### Factor 2 — keyed by IP, not per principal → **CONFIRMED**
Stock `ThrottlerGuard` (app.module.ts:68), no custom `getTracker`. Throttler v6 default: `async getTracker(req){ return req.ip; }` (read directly from `throttler.guard.js`). The key is `sha256(ClassName-HandlerName-bucketName-<ip>)` — so counters are **per (route, bucket, IP)**, NOT per authenticated user. `apps/api/src/main.ts` sets **no `trust proxy`**, and the browser fetches the API directly at `localhost:3001`, so in dev every tab/user/session shares one socket-peer IP → one budget per route. Live proof (T3, `repro/run-6-t3.log`): two independent browser contexts behind the same IP share the per-route budget — context A drained `GET /v1/time-entries/running` (4×200, 36×429); context B (a separate context, same IP) then got **429 on ALL 5** of its plain reads of that route without doing anything unusual. CORS sends **no `Access-Control-Expose-Headers`**, confirmed on the wire (`curl` to `/v1/projects`).

### Factor 3 — frontend surfaces 429 as a hard error everywhere except `/me` → **CONFIRMED, with a load-bearing header correction**
`apps/web/src/lib/query-client.ts:12-18` `retry` predicate returns `false` for any 4xx (incl. 429) → a transient 429 is terminal, panel renders an error state with no backoff. `apps/web/src/lib/auth.ts` honors `ApiError.retryAfterMs` ONLY in `useCurrentUser` (`authRetryDelay`); general queries ignore it.
**Header correction (matters for the fix):** the throttled-read 429 carries **`Retry-After-auth: 60`** on the wire (NOT `Retry-After-global`, NOT plain `Retry-After`) — confirmed live in `run-3.log` T2 (`retryAfterAuth:"60"`, `retryAfterGlobal:null`, `retryAfter:null` on all 316 observed 429s). The header suffix is the *bucket that blocked* (`auth`), so `apps/web/src/lib/api-client.ts:54` `parseRetryAfterMs` (which reads `Retry-After-auth` first) WOULD parse it — **except the API does not list it in `Access-Control-Expose-Headers`, so the browser `fetch` cannot read it** (in-page `headers.get('retry-after-auth')` returned `null` in the probe while Playwright's raw wire log saw `60`). Net: `ApiError.retryAfterMs` is `undefined` in the browser even for `/me`, and the auth backoff silently falls back to exponential. Any generalized client backoff that wants to honor the hint MUST also add `Retry-After-auth` (and/or whatever name the fix standardizes on) to CORS `exposedHeaders`.

## Also-investigated (load-bearing for the fix)
- **SSE is NOT a multiplier.** `apps/web` has **no `EventSource` client** — `TimerBar.tsx:18` only has a `TODO` to switch to SSE. `GET /v1/sync/events` is never opened by the web app, so it adds zero throttler pressure today. (It would count against the buckets if/when wired; flag for the future SSE work.)
- **`/me` is on the global path** (skips only `auth`), confirmed at auth.controller.ts:342 and by the throttler-skip unit test. Its 5×200 in the fan-out shows it is NOT the bottleneck — it is the only read that is *exempt* from the 5/60s `auth` cap, which is exactly why it does not 429 while its sibling reads do.
- **Per-page fan-out (grounding the budget recommendation):** `/timesheets` landing = `/v1/auth/me`, `/v1/time-entries/running`, `/v1/projects`, `/v1/time-entries` (+ `/v1/auth/idp-info`, the two oidc POSTs during sign-in). `/dashboard` adds `/v1/reports/team-dashboard`; `/leave` adds `/v1/leave/requests`. **~4-6 reads per page**, 6 of the 7 sign-in/landing requests NOT exempt from the `auth` bucket.

## Fix direction (one line)
Right-size the limiter so routine reads are not capped at 5/60s, and key it per authenticated principal. Concretely: (1) make `global` (per-principal) the only bucket that applies app-wide and raise/keep it sensibly; STOP letting the 5/60s `auth` bucket apply to non-auth routes; (2) add a custom `getTracker` returning the authenticated user id (falling back to IP for unauthenticated routes); (3) generalize the client 429 backoff and expose the `Retry-After-*` header via CORS. Detail + options in `HOTFIX_PLAN.md`.

## Prevention
- Backend unit test asserting non-auth routes are NOT subject to the `auth` bucket (the regression that bit here is "a small named bucket silently applies to all routes"). Plus a live/integration test that two principals behind one IP get independent budgets and that auth 5/60s on login/callback is preserved.
- Frontend test: a non-`/me` query that receives a 429 backs off and recovers instead of hard-erroring.
- Lint/architecture note in app.module.ts that any `forRoot` named bucket applies globally unless skipped.
