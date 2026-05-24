# INC-005 repro notes

Live reproduction of issue #8 (aggressive rate limit) against the running Docker
stack, signed in as `alice@harvoost.local` via real Keycloak. All runs use the
`chromium-live` project at `http://localhost:3000` / API `:3001`.

## Files
- `playwright.repro.config.ts` — throwaway live config (mirrors tests/e2e chromium-live), testDir = this folder.
- `global-throttle.repro.spec.ts` — 3 tests:
  - T1 FAN-OUT: counts /v1 requests for one authed landing + 4 navs.
  - T2 EXHAUSTION: drains the limiter, then drives UI reads → 429 across multiple endpoints; captures the raw 429 wire-header name.
  - T3 CROSS-CONTEXT: two browser contexts behind one IP share the per-route budget.
- `effective-limit.probe.spec.ts` — isolates the EFFECTIVE per-route read ceiling on a fully fresh window.
- `run-*.log` — captured output (see below).

## How to run (stack up, paced one login per 60s window)
```
cd tests/e2e
E2E_LIVE=1 E2E_SKIP_WEB_SERVER=1 pnpm exec playwright test \
  --config ../../.hacktogether/runs/87edeba4-9a80-4a73-858b-548fd9026da4/incidents/INC-005/repro/playwright.repro.config.ts \
  --reporter=list
```
PACING CAVEAT: the limiter is shared and small. The repro deliberately drains it,
so back-to-back runs poison each other's auth-login window (the 5/60s `auth`
bucket gates `POST /v1/auth/oidc/login` too). Wait ~75-90s of quiet between runs.
Several T3 failures in run-4/run-5 are exactly this: the login itself got 429'd
because a prior run had just spent the auth window — itself a live demonstration
of how aggressive the limit is.

## Headline measured results
- effective-limit.probe (run-2-probe.log): on a CLEAN window, `GET /v1/projects`
  returns 4×200 then **429 at request #5** — the per-route `auth` 5/60s ceiling.
- T1 (run-1/run-3): sign-in + landing = **7** /v1 requests; landing + 4 navs = **21**.
  In run-3, ordinary navigation alone produced **2 organic 429s** (no synthetic load).
- T2 (run-1/run-3): drain → 429 across **multiple endpoints**
  (`/v1/time-entries/running`, `/v1/projects`, …). 429 WIRE HEADER =
  **`Retry-After-auth: 60`** (NOT `Retry-After-global`, NOT plain `Retry-After`)
  on all observed 429s. In-page `fetch().headers.get('retry-after-auth')` returns
  `null` because CORS does not expose it.
- T3 (run-6-t3.log): two contexts behind one IP share the per-route budget —
  context A drains a route, context B's reads of that route 429 immediately.

## Root-cause correction vs the issue
The binding limit is the **`auth` 5/60s** bucket, which `forRoot` applies to
EVERY route (only `/me` skips it), NOT the `global` 300/60s bucket. See
../ROOT_CAUSE.md.
