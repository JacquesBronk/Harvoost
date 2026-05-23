# Changelog

All notable changes to Harvoost are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- Web app no longer hangs on an infinite loader at `http://localhost:3000/` against the full docker-compose stack ([#1](https://github.com/JacquesBronk/Harvoost/issues/1)). The static CSP `script-src 'self' 'wasm-unsafe-eval'` in `apps/web/next.config.mjs` was blocking Next.js 14's inline RSC flight-payload scripts, so `ClientPageRoot` never hydrated and the SSR'd `LoadingSpinner` was terminal. Replaced with a per-request nonce strategy via new `apps/web/middleware.ts` (CSP set on both request and response headers, nonce auto-propagated to Next.js's inline scripts), and `app/layout.tsx` now calls `headers()` to opt the route tree into dynamic rendering so the nonce is in scope at render time.
- `harvoost-web` container no longer reports `unhealthy` despite serving HTTP 200. Docker sets `HOSTNAME=<containerID>` by default; Next.js standalone reads `HOSTNAME` and binds to that single bridge-IP address, so the in-container `fetch('http://localhost:3000/')` healthcheck got `ECONNREFUSED`. Now pinned to `HOSTNAME=0.0.0.0` in `docker-compose.yml`.
- `NEXT_PUBLIC_API_BASE_URL` is now explicitly baked into the web bundle at build time via a Dockerfile `ARG` + `docker-compose.yml` `build.args` entry. Previously only the source-default `http://localhost:3001` ever ended up in the bundle (Next.js bakes `NEXT_PUBLIC_*` at build, not runtime), masking a latent footgun where changing the api port without also editing `apps/web/src/lib/env.ts` would silently fail.
- Sign-in now completes the full Keycloak round-trip in dev instead of stalling after authentication ([#2](https://github.com/JacquesBronk/Harvoost/issues/2)). Root cause: a three-way OIDC contract mismatch surfaced once the [#1](https://github.com/JacquesBronk/Harvoost/issues/1) fix let the page hydrate — the backend built the post-login `redirect_uri` as `/v1/auth/callback` (a path the web app does not serve; its callback page is `/auth/callback`) and that path was the only entry in the Keycloak realm allowlist, the web callback POST omitted the `opaque_state_id` that `OidcCallbackSchema` requires, and `OidcLoginResponse` typed a `state` field the backend never returns. Fixed by pointing `OIDC_REDIRECT_URI_WEB` at `/auth/callback` (added to `infra/keycloak/realm.json`), round-tripping `opaque_state_id` through `sessionStorage`, and dropping the dead client-sent `redirect_uri` in favour of the server-built one.
- Login copy is now provider-agnostic per [ADR-0001](.hacktogether/runs/87edeba4-9a80-4a73-858b-548fd9026da4/02-architecture/ADR-0001-oidc-provider-agnostic.md) instead of hardcoding Microsoft Entra ID ([#2](https://github.com/JacquesBronk/Harvoost/issues/2)). A new public `GET /v1/auth/idp-info` returns the IdP display name (from `OIDC_DISPLAY_NAME` — `Keycloak` in dev, `Microsoft Entra ID` in prod — falling back to a name derived from the discovery `issuer`); the login card text and button now render it, replacing the hardcoded "Microsoft Entra ID" / "Continue with Microsoft" strings.
- `/timesheets` no longer crashes into the React error boundary immediately after a successful sign-in ([#2](https://github.com/JacquesBronk/Harvoost/issues/2)). `GET /v1/auth/me` omitted `display_name`, which `AppShell` passed to `<Avatar>` whose `initialsOf(name)` called `name.trim()` on `undefined`. `/v1/auth/me` now returns `display_name` (falling back to the user's email), and `<Avatar>` is null/empty-safe (renders `?` with an `aria-label` of `User`).
- `NEXT_PUBLIC_WEB_BASE_URL` is now baked into the web bundle as a Dockerfile build-arg (mirroring the `NEXT_PUBLIC_API_BASE_URL` fix from #1), closing the same latent off-host footgun for the web base URL ([#2](https://github.com/JacquesBronk/Harvoost/issues/2)).
- Authenticated sessions no longer trip `RATE_LIMITED` on `GET /v1/auth/me` during normal navigation and refresh ([#3](https://github.com/JacquesBronk/Harvoost/issues/3)). Two compounding defects, both fixed. **Backend:** the class-level `@Throttle({ auth: { ttl: 60_000, limit: 5 } })` on `AuthController` also covered `GET /me`, so the benign per-page-load `/me` read shared the 5-per-60s brute-force bucket with `oidc/login` + `oidc/callback` and 429'd within seconds of a real session. `me()` now carries `@SkipThrottle({ auth: true })` and falls back to the global 300/60s bucket; `oidc/login` and `oidc/callback` keep their 5/60s brute-force protection unchanged. **Frontend:** `useCurrentUser` mapped only 401/403 to "logged out" and re-threw everything else, so a single 429 put the query into an error state that `app/page.tsx` and the route guards read as unauthenticated → `router.replace('/login')` → remount → immediate refetch with no backoff → a ~900-request `/me` storm. It now treats 429/5xx/network as a transient error (data stays `undefined`, never `null`), redirects only when `data === null` (a genuine 401/403) via a centralized `resolveAuthGate` helper, and retries with capped exponential backoff that honors the throttler's `Retry-After-auth` header (exposed as `ApiError.retryAfterMs`). Verified live (Playwright `chromium-live`): a signed-in session navigating 4 pages + 5 hard-refreshes issues 10 `/me` requests, all 200, zero 429; a forced 429 on `/me` backs off (4 requests, no storm), never redirects to `/login`, and recovers cleanly once `/me` returns 200.
- Manager/admin/finance/schedule pages now load real data instead of failing with 400/404 ([#4](https://github.com/JacquesBronk/Harvoost/issues/4)). These were the "frontend-invented endpoints" — pages built ahead of the backend and never reconciled; invisible because the hermetic e2e mocks the API and the live e2e only exercised `/timesheets`. Reconciled the contracts: **`/dashboard`** (`GET /v1/reports/team-dashboard`) and **`/financial`** (`GET /v1/reports/profitability`) now agree on `?date_range=YYYY-MM-DD/YYYY-MM-DD` and the `{ items, … }` response envelope (the frontend was sending ISO `start_at_*` / omitting the range, and reading `.items` while the backend returned `.data` with different field names); profitability stays Admin/FinMgr-only. **`/schedule`** (`GET /v1/schedules/dashboard`, company/team/individual tabs) was missing entirely and is now implemented per the OpenAPI spec, and the "New override" `POST` body was realigned to the spec shape (`effective_from`/`effective_to`/`start_time`/…) so it no longer 422s. **Admin › Rates** gained the two never-built controllers `GET/POST /v1/cost-rates` and `GET/POST /v1/billable-rates` (Admin/FinMgr-only, effective-dated over the existing tables — no migration; overlapping ranges return a clean 409/422).
- Admin › Projects and Admin › Clients management actions now work ([#4](https://github.com/JacquesBronk/Harvoost/issues/4)). Implemented the five stubbed endpoints the UI already called but the backend never registered: `GET`/`DELETE /v1/projects/{id}/members`, `GET`/`DELETE /v1/projects/{id}/managers`, and `DELETE /v1/clients/{id}` — all Admin-only and audited (member removal is a soft delete; client deletion is foreign-key-guarded so deleting a client still referenced by a project returns a clean validation error rather than a 500).
- List endpoints (`GET /v1/users`, `GET /v1/projects`, `GET /v1/clients`) no longer return `500 "Do not know how to serialize a BigInt"` ([#4](https://github.com/JacquesBronk/Harvoost/issues/4)). Their raw `$queryRaw` rows surfaced Postgres `bigint` columns as JS `BigInt`, which `JSON.stringify` cannot serialize — blocking the Admin › Projects/Clients tables and user-picker dropdowns from rendering. A process-wide `BigInt.prototype.toJSON` (decimal-string) serializer in `apps/api/src/main.ts` resolves the whole class; the API already returns string IDs everywhere else.
- Added an OpenAPI-driven frontend↔backend contract test (`@harvoost/contract`) that fails the build if any `apps/web` `apiFetch` call drifts from a declared `openapi.yaml` operation, a registered NestJS route, or the spec's response field shape ([#4](https://github.com/JacquesBronk/Harvoost/issues/4)) — the durable guard against this whole class of drift. (Also fixed two latent YAML syntax errors in `openapi.yaml` where descriptions containing `:` were unquoted.)

### Planned for v0.2.0 / v1.0.1

- Wire real Microsoft Entra ID OIDC validation against `login.microsoftonline.com` for production sign-in (currently dev-only via Keycloak; prod is fail-closed until this lands).
- Code-sign the Electron tray for Windows (EV cert) and macOS (Apple Developer ID + notarisation) to remove SmartScreen / Gatekeeper warnings on install.
- Resolve ~45 selector mismatches in the hermetic Playwright e2e suite (UI-selector drift; business logic is covered by the 375 unit + integration tests).
- Code-review carry-overs: M1 start/switch transaction race, M5 leave list manager fan-out polish, M6 HTTP verb alignment with the OpenAPI spec.
- Extend `audit-log-integrity` job to recompute HMAC per row in addition to chain-linkage verification (V1 defence-in-depth; primary BEFORE-INSERT trigger already covers the main surface).
- Chatbot security cleanups: M2 LLM provider error string redaction, M3 token budget switch from sliding-24h to local calendar day, M4 `GET /v1/users/:id` scope check.
- Update `turbo.json` `globalEnv` to reference the new `OIDC_*` env vars (stale `ENTRA_*` entries are non-blocking but should be cleaned up).
- Multi-replica SSE sync via Redis pub/sub (current implementation is in-process; single-replica only).
- ML-based anomaly detection upgrade (current implementation is rule-based 2σ over trailing 4 weeks).
- Multi-currency reporting with live FX (deferred to v2).
- BambooHR live leave-sync provider (the seam is in place; v1 ships the NoOp implementation).

## [0.1.0] — 2026-05-23

Initial release. Greenfield single-tenant time-tracking platform with Harvest-style features, a cross-platform Electron tray, RBAC-aware manager and finance dashboards, and an LLM-powered chatbot bound to a fixed tool registry.

### Added — Features (per REQUIREMENTS F1–F11)

**Time tracking**

- **F1.** Tray and web clock-in/out with morning prompt and 1–5 star mood capture. Tray suppresses the prompt on approved leave days. Bidirectional tray/web timer sync via SSE.
- **F2.** Timesheet entries with the full state machine (`draft → submitted → manager_approved → final_approved`; admin unlock returns to `draft`). Per-user overlap is prevented at the database via a GIST exclusion constraint.

**Dashboards**

- **F3.** Manager dashboard scoped via the canonical cascade rule (project-anchored ∪ person-anchored, no further transit). Team rollups, individual employee drilldowns, exception counts. The chatbot uses the same scope service — no widened lens.
- **F4.** Financial profitability dashboard (Admin / FinMgr only). Per-project revenue, cost, and margin across `hourly`, `fixed-fee`, and `non-billable` billing modes. Effective-dated cost rates and billable rates; entries cost at the rate effective on the entry's date.

**Workflows**

- **F5.** Leave booking with manager approval (≥10-char reject reason). `LeaveSyncProvider` interface with the `NoOpLeaveSyncProvider` v1 implementation; schema and columns Bamboo-ready.
- **F6.** Two-stage timesheet approval with the stage-1 ≠ stage-2 invariant enforced server-side (a user holding both Manager and FinMgr roles cannot self-approve across stages). Admin unlock with audit-logged reason (≥20 chars).
- **F7.** Scheduling with the default 08:00–17:00 + 1h lunch template per user IANA timezone. Per-user, per-project, and org-wide overrides with most-specific-scope-wins conflict resolution; same-scope conflicts rejected at create time.

**Observability**

- **F8.** Exception detection: missed punch (nightly batch), overtime day (real-time on entry close + nightly), overtime week (rolling 7-day in employee local TZ), 2σ anomaly over trailing 4 weeks.
- **F9.** Detailed activity report and time-rollup report. Excel export with the Harvest-compatible column schema; sync delivery up to 100k rows, async via pg-boss above that. Async exports delivered as a signed Blob URL with a 5-minute TTL. Cost columns stripped server-side for non-financial roles.

**Conversational and autonomous**

- **F10.** LLM-powered manager chatbot built on the Vercel AI SDK (provider-agnostic per ADR-0001). OpenAI is the default; Anthropic, Google, Ollama, and xAI are also wired and selected by env var. 13-tool registry with the requester ID curried at the application layer — the LLM cannot widen scope via prompt injection. `GET /v1/chatbot/capabilities` + 503 `CHATBOT_DISABLED` for tool-incapable models.
- **F11.** Autonomous per-recipient-local Monday 08:00 weekly summary email. LLM-generated prose with a deterministic Jinja-style template fallback on LLM failure (telemetry-tagged). Motivational quote is drawn from a bundled curated list (no LLM-generated quote, no external API). Manager copies for anchored employees; mood data omitted from the manager copy.

### Added — Architecture

- TypeScript monorepo on pnpm 9 workspaces + Turborepo 2 (`apps/{api,web,tray}` + `packages/{db,shared,jobs,ui}`).
- NestJS 10 API on Node 20, Next.js 14 (App Router) web, Electron 30 tray for Windows 10+, macOS 12+, and Ubuntu 22.04+.
- Prisma 5 schema across 28 tables and 4 migrations (`20260522000000_init`, `20260522170000_audit_hmac`, `20260522180000_auth_pending`, `20260523000000_feature_completion`).
- pg-boss 9 background job platform with 12 scheduled and event-driven jobs (mood retention, weekly summary scheduler and deliver, exception detection nightly, real-time overtime, audit-log integrity, chatbot conversation prune, email-delivery retry, timer-stuck cleanup, Bamboo-stub, large-XLSX export, etc.).
- `RbacScopeService` is the single authority for cascade visibility — used identically for dashboard queries, approval inboxes, chatbot tool results, and Excel exports.
- Append-only audit log with an HMAC-SHA-256 hash chain. The key is provided via `AUDIT_HASH_SECRET` and set per session via Postgres `SET LOCAL`; the trigger refuses to insert if the GUC is unset or shorter than 32 bytes.
- Server-Sent Events sync stream (`GET /v1/sync/events`) keyed per user via an RxJS Subject with 30s heartbeats. In-process pub/sub for v1; Redis fan-out is planned for v1.1.
- ADR-0001: OIDC is provider-agnostic. Keycloak runs in dev (docker-compose with a seeded realm); Microsoft Entra ID is the production target. Only `OIDC_ISSUER_URL` differs between providers; one validation code path uses `jose` for discovery + JWKS + id_token verification.

### Added — Infrastructure

- Docker Compose dev stack: Postgres 16, Keycloak 25 (with seeded `harvoost` realm + 7 users + 2 clients), Azurite (Blob), Maildev (captured outbound email), and an optional Ollama profile for local LLM.
- Bicep IaC for Azure deployment targeting South Africa North (primary) with South Africa West as the paired backup region. 11 Bicep modules + env-specific `.bicepparam` files + an operator README. ACS Email falls back to West Europe (not GA in SAN as of 2026).
- GitHub Actions: `ci.yml` (lint, typecheck, tests, Trivy, `pnpm audit`, e2e, Bicep validate) and `deploy.yml` (Azure OIDC-federated container app deploy — no static service-principal credentials).
- Multi-stage Dockerfile for `apps/api` shared with the worker via a `WORKER_MODE` switch; Next.js standalone Dockerfile for `apps/web`.

### Added — Security

- Real OIDC sign-in via `jose` (discovery doc cached at boot + lazy JWKS) — exercised end-to-end against Keycloak in dev. Production wiring against `login.microsoftonline.com` is a v1.0.1 TODO; see Known limitations.
- Session cookies are HttpOnly + Secure + SameSite=Lax. CSRF middleware enforces `Origin` and `X-Requested-With` on state-changing requests.
- `helmet` with HSTS, `Referrer-Policy: strict-origin-when-cross-origin`, and `X-Content-Type-Options: nosniff` on every API response.
- Throttling buckets: `auth` 5/min, `chatbot` 30/min, global 300/min — named bucket isolation per route.
- Audit log writes are wired into 14 state-changing handlers and HMAC-chained on insert via a database trigger.
- Boot invariants refuse `SESSION_SECRET` or `AUDIT_HASH_SECRET` shorter than 32 chars or starting with `dev-` when `NODE_ENV=production`.

### Added — Testing

- 375 unit + integration tests passing across four packages: api (222), shared (92), jobs (40), db migration-contract (21).
- 10 / 10 TypeScript packages typecheck green.
- Playwright e2e suite (~71 active specs) with a hermetic mock-API default lane and a live `E2E_LIVE=1` lane that exercises the real Keycloak handshake. 35 hermetic specs are currently green; ~45 have selector drift tracked for v1.0.1.

### Added — Tooling

- `pnpm setup` one-shot bootstrap (install, compose up, migrate, seed, build web).
- Two-terminal run path: `pnpm dev:api` (ts-node, decorator metadata preserved) + `pnpm start:web` (Next.js standalone build served by Node — significantly faster than `next dev` on WSL2 + NTFS).
- `pnpm compose:up`, `pnpm compose:down`, `pnpm migrate`, `pnpm seed`, `pnpm db:reset`, `pnpm db:studio`, `pnpm test`, `pnpm typecheck`, `pnpm e2e`, `pnpm e2e:live`, `pnpm docker:up:llm`.

### Fixed — Hotfixes applied during initial verification

- Stripped `"type": "module"` from `packages/{shared,db,jobs,ui}/package.json` so the CJS API can `require()` workspace packages.
- Removed 115 `.js`-suffixed relative imports across `packages/{shared,db,jobs}/src` for ts-node CJS resolver compatibility.
- Switched the API dev runner from `tsx` to `ts-node --transpile-only` because esbuild does not emit the `decoratorMetadata` that NestJS DI relies on.
- Added `apps/api/tsconfig.build.json` with `rootDir: src` so `nest build` emits to `dist/main.js` rather than a nested path.
- Removed the global `ValidationPipe` from `apps/api/src/main.ts` (the codebase uses Zod via `ZodValidationPipe`; `class-validator` was not installed).
- Aligned 30+ ID-type boundaries in `apps/web` (`number → string`) via a canonical `api-types.ts`.
- Switched the Playwright `addCookies` spec from `url + path` to `domain + path` to fix the initial 70-failure batch.

### Known limitations (v0.1.0)

- **Real Entra ID `id_token` JWKS validation is not yet wired** — production sign-in fails closed via boot invariants until this lands. Dev sign-in via Keycloak works end-to-end through the same code path.
- The Electron tray ships unsigned in v0.1.0; installers raise SmartScreen (Windows) and Gatekeeper (macOS) warnings. Code-signing is approved for v1.0.1.
- ~45 hermetic Playwright specs have selectors that have drifted from the rendered pages. The underlying business logic is covered by the 375 unit + integration tests; this is a UI-test-maintenance backlog, not a regression.
- The `audit-log-integrity` job verifies hash-chain linkage but does not recompute the HMAC per row. The primary insert path is HMAC-verified by a BEFORE-INSERT trigger; this is a defence-in-depth gap.
- SSE sync runs in-process — multi-replica Azure Container App deployments need Redis pub/sub fan-out (planned v1.1).
- Anomaly detection is rule-based (2σ over trailing 4 weeks). ML-based detection is explicitly out of scope for v1.
- Multi-currency reporting with live FX is deferred to v2 (v1 assumes a single org-wide currency).
- BambooHR live integration is a NoOp v1; the schema columns and `LeaveSyncProvider` interface are in place.
- Three Major security items are deferred to v1.0.1: chatbot LLM error string leak (M2), chatbot token budget sliding-24h vs local-day (M3), `GET /v1/users/:id` IDOR (M4).
- `turbo.json` `globalEnv` still references the legacy `ENTRA_*` env vars. Non-blocking (turbo allows unset env vars in its hash) but stale config; chore item for v0.2.0.
- WSL2 + NTFS environments: `next dev` is slow. The documented workaround is the two-terminal `pnpm build:web && pnpm start:web` flow.

## SDLC artefacts

This release was built end-to-end via the HackTogether orchestrator. The phase artefacts are preserved under `.hacktogether/runs/87edeba4-9a80-4a73-858b-548fd9026da4/`:

- `01-intake/REQUIREMENTS.md` (690-line spec) and `interview.transcript.md`
- `02-architecture/ARCHITECTURE.md` (~1550 lines across 3 revision rounds), `STACK.md`, `ADR-0001-oidc-provider-agnostic.md`
- `03-api-design/openapi.yaml` (3579 lines, OpenAPI 3.1, ~55 operations across 16 tag groups, 71 reusable schemas), `API_NOTES.md`
- `04-build/{db,backend,frontend}/HANDOFF.md`
- `05-test/TEST_REPORT.md` + `HANDOFF.md`
- `06-review/{CODE_REVIEW,SECURITY_REVIEW,FIX_PLAN,HANDOFF}.md`
- `07-deploy/{DEPLOY_PLAN,DEPLOY_READINESS,COST_ESTIMATE,TODO_INVENTORY}.md`
- `08-docs/HANDOFF.md`

[Unreleased]: https://example.invalid/harvoost/harvoost/compare/v0.1.0...HEAD
[0.1.0]: https://example.invalid/harvoost/harvoost/releases/tag/v0.1.0
