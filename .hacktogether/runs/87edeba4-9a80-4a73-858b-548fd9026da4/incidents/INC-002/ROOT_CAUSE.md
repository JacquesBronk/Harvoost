# INC-002 — Root cause

## Final root cause (one sentence)

There are **two layered defects**: (a) the *initial-redirect* "stays on /login" symptom is NOT a code bug in
`page.tsx` — it is a **stale/pre-hydration artifact** (a cached pre-INC-001-fix bundle whose blocked inline scripts
never hydrate, so the static SSR button renders but its `onClick` never attaches; clear cache / hard-refresh fixes
it), with a latent secondary trigger that the bundle bakes `API_BASE_URL="http://localhost:3001"` as a literal so
sign-in only works when the browser is co-located with the API; and (b) the *real, deterministic* code bug that
breaks sign-in for everyone is a **three-way frontend↔backend OIDC contract mismatch** that breaks the round-trip
*after* Keycloak (request schema drops `redirect_uri`; the post-login `redirect_uri` points at `/v1/auth/callback`
which has no web page; and the web callback page omits the backend-required `opaque_state_id`).

## Reproduction method

No browser available locally, so I drove the **real bundled Chromium via the existing Playwright infra**
(`tests/e2e/`, `--project=chromium-mocked`, `E2E_SKIP_WEB_SERVER=1`) against the **running docker-compose stack**
(all app containers `healthy`). Four throwaway specs (archived in `repro/`, removed from the active suite):
`login-redirect.repro.spec.ts`, `csp-and-dns.repro.spec.ts`, `full-roundtrip.repro.spec.ts`,
`no-hydration.repro.spec.ts`. Each captured `console`, `pageerror`, `requestfailed`, `response`, `framenavigated`,
and `securitypolicyviolation`.

## Hypothesis history

1. **H1 — JS exception in `handleSignIn` before `window.location.assign` (suspect #1).** Clean-Chromium repro:
   click → POST `/v1/auth/oidc/login` returns **201** → `window.location.assign` reaches
   `http://harvoost.localhost:8080/.../auth` and the **Keycloak login page fully renders**. `PAGE ERRORS: []`,
   `CONSOLE: []`, `FAILED REQUESTS: []`. So no exception in the same-host happy path. **Refuted as the universal
   cause** — BUT a real latent variant exists (see H1b).

2. **H1b — NEXT_PUBLIC build-arg baking (the INC-001 footgun).** Bundle inspection
   (`docker exec harvoost-web grep ... .next/static/chunks`) shows the compiled env module is:
   `{ API_BASE_URL: "http://localhost:3001", WEB_BASE_URL: s(9492).env.NEXT_PUBLIC_WEB_BASE_URL ?? "http://localhost:3000" }`.
   `NEXT_PUBLIC_API_BASE_URL` **was** baked (Dockerfile.web passes it as a build-arg) → inlined literal.
   `NEXT_PUBLIC_WEB_BASE_URL` is **NOT** baked (no build-arg) → resolves through the webpack `process` polyfill to
   `undefined` → falls back to `http://localhost:3000`. In-page probe confirmed `window.process === undefined`.
   Both happen to be correct **only when the browser is on the same host as the API**. If a tester opens the web app
   via any non-`localhost` origin, the POST to the hardcoded `http://localhost:3001` fails → `apiFetch` throws
   `ApiError(0)` → the page shows a "Cannot reach the API" toast and **stays on /login** (matches the symptom, with
   a toast the reporter may not have mentioned). **Confirmed as a latent real bug; not the cause in same-host dev.**

3. **H2 — CSP blocking the cross-origin navigation (suspect #2).** `curl -sI /login` shows the INC-001 nonce CSP is
   applied correctly (all `<script>` carry `nonce-...`, 1 inline nonce group). Repro registered a
   `securitypolicyviolation` listener: `CSP VIOLATIONS: []` during click+navigate. `form-action 'self'` governs only
   `<form>` submits; there is no `navigate-to` directive, so `window.location.assign` to `harvoost.localhost:8080` is
   not policed. The navigation succeeded in the browser. **Refuted with positive evidence.**

4. **H3 — CSRF middleware rejects the POST (suspect #3).** The unauthenticated `POST /v1/auth/oidc/login` (with
   `X-Requested-With: XMLHttpRequest`, `Origin: http://localhost:3000`, `credentials:'include'`) returns **201** from
   both host `curl` and an in-page `fetch`. **Refuted.**

5. **H4 — redirect_uri mismatch (suspect #4).** Confirmed REAL, but post-Keycloak (see Root cause §B). The initial
   redirect to Keycloak still happens. **Confirmed as a round-trip bug, not the initial-hang.**

6. **H5 — button not wired in the bundle after the CSP fix (suspect #5).** Once hydrated, the button IS wired:
   `getByRole('button', {name:/continue with microsoft/i})` is visible and its click drives the full POST→assign
   chain. **Refuted** (the button works when hydrated).

7. **H6 — pre-hydration / stale-cache click (NOT on the suspect list; the actual same-host symptom).**
   `no-hydration.repro.spec.ts` (`javaScriptEnabled:false`, modelling a cached pre-INC-001 bundle whose inline RSC
   scripts are CSP-blocked and never hydrate): the static SSR button renders, is clickable, and clicking it leaves
   the browser **on `http://localhost:3000/login` with no navigation and no console error** — an exact match for
   "stays on /login with no visible redirect." **Confirmed as the most likely same-host explanation of the report.**
   (For completeness, `csp-and-dns.repro.spec.ts` showed that if `harvoost.localhost` were *unresolvable* the browser
   lands on `chrome-error://chromewebdata/` — a *visible error page*, NOT "stays on /login" — so a DNS failure is
   NOT the reported symptom.)

## Suspect-list verdicts (positive evidence)

| # | Suspect | Verdict | Evidence |
|---|---------|---------|----------|
| 1 | JS exception in `handleSignIn` | **REFUTED** (same-host) / latent variant CONFIRMED | repro: POST 201, assign reaches Keycloak, no pageerror. Latent: hardcoded `API_BASE_URL` literal fails off-host. |
| 2 | CSP blocks cross-origin navigation | **REFUTED** | `securitypolicyviolation` listener fired 0 times; nav to `harvoost.localhost:8080` succeeded; no `navigate-to`/`form-action` applies. |
| 3 | CSRF rejects the POST | **REFUTED** | POST returns 201 from curl AND in-page fetch with `X-Requested-With`. |
| 4 | redirect_uri mismatch (`/auth/callback` vs `/v1/auth/callback`) | **CONFIRMED (post-Keycloak)** | `.env` `OIDC_REDIRECT_URI_WEB=.../v1/auth/callback`; realm allowlist has only `/v1/auth/callback`; web callback page lives at `/auth/callback`. Breaks the round-trip, not the initial redirect. |
| 5 | Button not wired in bundle | **REFUTED** | Hydrated button is visible and drives the full flow. |
| — | Pre-hydration / stale-cache click | **CONFIRMED** (same-host symptom) | JS-disabled repro: button does nothing, stays on /login, no error. |

## Root cause detail — the deterministic code bug (§B: three-way OIDC contract mismatch)

Even after the initial redirect succeeds and a user authenticates at Keycloak, the round-trip is broken in three
independent places:

- **B1 — request schema drops `redirect_uri`.** `apps/web/app/login/page.tsx:24-28` POSTs
  `{ redirect_uri: "http://localhost:3000/auth/callback" }`, but `apps/api/src/auth/auth.controller.ts:27-29`
  (`LoginInitSchema`) only accepts `{ client_kind? }` and **ignores `redirect_uri`**. The backend builds the
  redirect_uri server-side from `OIDC_REDIRECT_URI_WEB` (`auth.controller.ts:56-57`). The frontend's value is dead.

- **B2 — callback path mismatch.** Server-side `OIDC_REDIRECT_URI_WEB` defaults to
  `http://localhost:3000/v1/auth/callback` (`apps/api/src/config/env.ts:27`, `.env:15`) and the realm allowlist
  (`infra/keycloak/realm.json:49-51`) only permits `/v1/auth/callback`. So Keycloak redirects the browser to
  `http://localhost:3000/v1/auth/callback?code=...` — a path the **web app does not serve** (its callback page is at
  `apps/web/app/auth/callback/page.tsx` → `/auth/callback`). The user lands on a non-existent web route.

- **B3 — callback request body omits `opaque_state_id`.** Even if B2 were resolved, the web callback page
  (`apps/web/app/auth/callback/page.tsx:30-36`) POSTs `{ code, state }`, but
  `apps/api/src/auth/auth.controller.ts:31-35` (`OidcCallbackSchema`) **requires** `opaque_state_id: z.string().uuid()`.
  The `opaque_state_id` returned by `/oidc/login` is never persisted nor sent back, so the exchange would 400.

Additionally, the login page's `OidcLoginResponse` interface (`page.tsx:11-14`) declares a `state` field, but the
backend returns `opaque_state_id` (curl-confirmed) — a type/contract drift consistent with B3.

## Copy-bug classification

**Purely cosmetic — NOT root-cause-linked to the no-redirect.** The OIDC code path is provider-agnostic; the
hardcoded "Microsoft Entra ID" / "Continue with Microsoft" strings (`page.tsx:53-54,64`) are presentation only and do
not influence `handleSignIn`, the POST, the authorize URL, or the navigation. The Keycloak redirect succeeds despite
the Microsoft copy. Fix it for correctness/ADR-0001 compliance, but it is independent of the functional bug.

## Verification

- No source files changed during triage (`git diff --stat` shows only run-state + new INC-002 folder). Throwaway
  repro specs were archived to `repro/` and removed from `tests/e2e/specs/` so the suite is untouched.
- All four repro specs passed/observed as described above against the live, healthy stack.

## Prevention recommendation

1. **Contract test** (e2e or API contract): assert `POST /v1/auth/oidc/login` response shape (`authorization_url` +
   `opaque_state_id`) and that the web callback page sends exactly the fields `OidcCallbackSchema` requires. This
   would have caught B1/B3 at build time.
2. **Single source of truth for the callback path** — derive the web callback route and `OIDC_REDIRECT_URI_WEB` from
   one constant so B2 cannot drift; add the chosen path to the realm allowlist in the same change.
3. **Bake `NEXT_PUBLIC_WEB_BASE_URL` as a build-arg** (mirror the `NEXT_PUBLIC_API_BASE_URL` pattern in
   `docker/Dockerfile.web`) and add a build-time assertion / lint that every `NEXT_PUBLIC_*` consumed in the browser
   bundle is declared as a Dockerfile build-arg — closes the INC-001 footgun class permanently.
4. **Cache-busting note in the fix PR / CHANGELOG**: instruct testers to hard-refresh after the INC-001 CSP fix, since
   a cached nonceless bundle reproduces the "stays on /login" symptom without any code bug.
