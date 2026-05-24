---
phase: INC-005
agent: debugger
started: 2026-05-24
finished: 2026-05-24
status: complete
---

# Summary
Reproduced and confirmed issue #8 LIVE (Playwright chromium-live, real Keycloak as alice@harvoost.local) and pinned the root cause. Normal navigation DOES trip 429 RATE_LIMITED across multiple endpoints — but the diagnosis was materially wrong about which bucket bites: the binding limit is the **`auth` 5/60s** bucket (which `ThrottlerModule.forRoot` applies to EVERY route in throttler v6 — only `/me` is exempt), NOT the `global` 300/60s bucket. On a clean window a single routine read (`GET /v1/projects`) 429s at the 5th request. Wrote ROOT_CAUSE.md, a decision-ready HOTFIX_PLAN.md (per-factor fix options for gate (a)), and a repro/ folder. Did not edit any application source.

# Files touched
- .hacktogether/runs/87edeba4-9a80-4a73-858b-548fd9026da4/incidents/INC-005/ROOT_CAUSE.md (new)
- .hacktogether/runs/87edeba4-9a80-4a73-858b-548fd9026da4/incidents/INC-005/HOTFIX_PLAN.md (new)
- .hacktogether/runs/87edeba4-9a80-4a73-858b-548fd9026da4/incidents/INC-005/repro/global-throttle.repro.spec.ts (new)
- .hacktogether/runs/87edeba4-9a80-4a73-858b-548fd9026da4/incidents/INC-005/repro/effective-limit.probe.spec.ts (new)
- .hacktogether/runs/87edeba4-9a80-4a73-858b-548fd9026da4/incidents/INC-005/repro/playwright.repro.config.ts (new)
- .hacktogether/runs/87edeba4-9a80-4a73-858b-548fd9026da4/incidents/INC-005/repro/NOTES.md (new)
- .hacktogether/runs/87edeba4-9a80-4a73-858b-548fd9026da4/incidents/INC-005/repro/run-*.log (new — captured live evidence)
- NO application source modified (apps/, tests/e2e/specs, tests/contract clean).

# What downstream agents need to know
- DECISION-WORTHY CORRECTION to the issue diagnosis: the over-aggressive limit is the **`auth` 5/60s** bucket applying to all routes (throttler v6 enforces every forRoot named bucket on every route unless @SkipThrottle names it). The `global` 300/60s bucket almost never bites. The fix must STOP the small `auth` bucket from governing non-auth reads (HOTFIX_PLAN Fix A1: make auth/chatbot opt-in via @Throttle, leave only `global` app-wide), AND add per-principal getTracker (Fix B), AND generalize the client 429 backoff + CORS-expose the Retry-After header (Fix D). Fix C (reduce fan-out) is nice-to-have.
- HEADER FACT (load-bearing): a throttled-read 429 carries `Retry-After-auth: 60` on the wire (NOT `Retry-After-global`, NOT plain `Retry-After`). It is NOT in CORS Access-Control-Expose-Headers, so the browser fetch cannot read it today — even useCurrentUser's "Retry-After-auth" backoff silently falls back to exponential. Any client backoff that honors the hint REQUIRES adding the header to main.ts CORS `exposedHeaders`.
- SSE is NOT a multiplier: apps/web has no EventSource client (TimerBar.tsx:18 is a TODO); GET /v1/sync/events is never opened. Do not wire SSE in this hotfix.
- req.user shape for getTracker: BearerAuthGuard sets req.user = { userId, email, roles } (bearer-auth.guard.ts:90,106).
- Implementer partition: backend-dev owns apps/api (Fixes A, B, CORS in main.ts + backend tests); frontend-dev owns apps/web (Fix D + optional C + frontend test). api-designer/openapi and @harvoost/contract are NOT involved (no schema change).
- E2E pacing: the limiter is shared and small; the repro drains it, so runs poison each other's auth-login window. Pace ~75-90s quiet between live runs (the verifier spec for the fix must do the same).

# Open questions / unknowns
- Budget target for the per-principal `global` bucket is a product call for gate (a): recommended >=600/60s (10 req/s). Options 300/600/1000 surfaced in HOTFIX_PLAN.
- Whether to also raise/keep `chatbot` 30/60s — left as-is per REPORT scope; not implicated by the repro.

# Verification evidence
- effective-limit probe (clean window) → `GET /v1/projects`: 4×200 then 429 at request #5 (auth 5/60s ceiling). repro/run-2-probe.log
- T1 fan-out → sign-in+landing = 7 /v1 reqs; landing+4 navs = 21; organic 429s appeared during plain navigation (run-3). repro/run-1.log, run-3.log
- T2 exhaustion → 429 across multiple endpoints; 429 wire header = `Retry-After-auth: 60`, `Retry-After-global: null`, `Retry-After: null` on all 316 observed 429s. PASSED. repro/run-3.log
- T3 cross-context → context A drained a route (4×200,36×429); context B (separate context, same IP) got 429 on ALL 5 plain reads. PASSED. repro/run-6-t3.log
- git status apps/ tests/e2e/specs tests/contract → clean (no application source modified).
