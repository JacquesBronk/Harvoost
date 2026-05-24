# INC-005 — Aggressive global rate limit (429 RATE_LIMITED across all endpoints)

- **GitHub issue:** #8
- **Run:** 87edeba4-9a80-4a73-858b-548fd9026da4
- **Opened:** 2026-05-24
- **Status:** triage (debugger reproduce + confirm)
- **Severity:** High — degrades the whole app for any signed-in user after a couple of normal navigations/refreshes within a 60s window.
- **Reporter flow:** directed hotfix (mirrors INC-001…INC-004): **skip incident-responder triage; dispatch debugger first to REPRODUCE + CONFIRM live (Playwright chromium-live), NOT re-discover.**

## Symptom
After signing in, a couple of page refreshes/navigations trip `429 {"code":"RATE_LIMITED"}` on many/all endpoints at once; multiple panels show "Could not load data" until the 60s window clears. Distinct from #3 (which was the `/me` redirect loop on the *auth* bucket) — here it is the **`global` 300/60s bucket** exhausted by ordinary multi-request page loads.

## Pre-diagnosed root cause (3 compounding factors — confirmed accurate at the static level by orchestrator)
1. **`global` bucket too small for per-navigation fan-out.** `apps/api/src/app.module.ts:43` → `{ name: 'global', ttl: 60_000, limit: 300 }` = 5 req/s sustained. One authed page load fans out into many parallel queries (`/v1/auth/me`, `/v1/time-entries/running`, reports, schedules, lists, `/v1/sync/events` SSE). #3 moved `/me` onto this `global` bucket, adding pressure.
2. **Limiter keyed by IP, not per user.** `app.module.ts:68` uses stock `ThrottlerGuard` (no custom `getTracker`). The 300/60s is shared across all tabs/users behind one IP — in dev (`localhost`) that is one budget for the whole app.
3. **Frontend surfaces 429 as a hard error everywhere except `/me`.** `apps/web/src/lib/query-client.ts:12-18` treats any 4xx (incl. 429) as terminal — no retry/backoff. The `Retry-After-aware` backoff from #3 lives only in `useCurrentUser` (`apps/web/src/lib/auth.ts`); `ApiError.retryAfterMs` is ignored outside `/me`.

## Acceptance criteria (from issue #8)
1. A single authed user navigating + refreshing normally does NOT trip `RATE_LIMITED` on routine reads.
2. Rate limit scoped per authenticated principal so one user/tab cannot exhaust the budget for everyone behind the same IP.
3. `auth` brute-force protection (5/60s on login/callback) preserved (per #3).
4. A transient 429 backs off and recovers instead of leaving panels in a hard error state.
5. Regression coverage for per-principal keying AND graceful 429 recovery on a non-`/me` query.

## Scope guardrails
- PRESERVE `auth` 5/60s on login/callback (per #3) and `/me`'s `@SkipThrottle({auth:true})` behavior.
- Do NOT regress INC-001 (CSP nonce), INC-002 (OIDC round-trip), INC-003 (/me storm), INC-004 (endpoint drift/BigInt), FEAT-001 (timer UI).
- Do NOT touch the real-Entra-in-prod OIDC path or `.github/` (still needs `workflow` OAuth scope).
- Keep `chatbot` 30/60s as-is unless the debugger shows it is implicated.

## HITL gates
- **(a)** before fix dispatch — debugger confirms + presents per-factor fix-direction options.
- **(b)** before push to main (commit trailer `closes #8`).
