# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Harvoost is a Harvest-style time-tracking SaaS: web app + API + Electron tray, with RBAC, clock-in/mood, two-stage timesheet approvals, leave, scheduling, exceptions, financial dashboards, an LLM chatbot, and weekly summaries. TypeScript monorepo on **pnpm 9 + Turborepo 2**, Node 20.

## Running the app

**Turnkey (recommended) — Docker.** From a fresh clone, with no setup and no `.env`:

```bash
docker compose up -d        # builds images if missing, starts infra, migrates + SEEDS, serves web
docker compose up -d --build  # add --build after changing app SOURCE (compose won't rebuild on its own)
docker compose down -v      # full reset: drops the seeded DB + imported Keycloak realm + volumes
```

`.env` is **optional** — `.env.example` (committed dev defaults) is layered as the base env for every app service via the `x-app-env-file` anchor; an optional `.env` overlays it. A one-shot `migrate` service runs `migrate:deploy` + `seed` before `api` starts, so the DB is always seeded. App at <http://localhost:3000>; sign in via Keycloak as `admin@harvoost.local` / `dev-admin-pass` (see all seeded users in README "Test users").

**Local dev (faster iteration, no image rebuild).** Run infra in Docker, apps on the host:

```bash
pnpm install
pnpm db:generate                 # REQUIRED — else PrismaService boots DEGRADED and DB endpoints 500
pnpm compose:up                  # postgres + keycloak + azurite + maildev only
pnpm migrate && pnpm seed
pnpm dev:api                     # API on :3001 (ts-node)
pnpm dev:web                     # web on :3000 (or: pnpm build:web && pnpm start:web — faster on WSL2)
```

Service URLs: API health `:3001/v1/health`, Keycloak `:8080` (admin `admin`/`dev-admin-not-for-prod`), Maildev `:1080`, Postgres `:5432` (`harvoost`/`dev`), Azurite blob `:10000`.

## Build / test / typecheck

```bash
pnpm test                              # all unit+integration suites (turbo, per-package vitest)
pnpm --filter @harvoost/api test       # one package
pnpm --filter @harvoost/api test path/to/file.test.ts     # one file
pnpm --filter @harvoost/api test -t "name fragment"        # one test (vitest -t)
pnpm typecheck                         # tsc --noEmit across all packages
pnpm e2e                               # Playwright, HERMETIC (mocked API) — no stack needed
pnpm e2e:live                          # Playwright against the LIVE stack (needs compose up + apps running; run pnpm e2e:install once)
```

**Caveats that will bite you (verify with typecheck + tests, not these):**
- **`nest build` is broken and unused.** The API runs via **ts-node** everywhere (Docker `CMD` and `pnpm dev:api`). The api `build` script (`nest build`) fails — do not use it; gate API changes with `pnpm --filter @harvoost/api typecheck` + `test`.
- **`lint` is broken repo-wide.** ESLint was bumped to v9 (flat config) but the configs weren't migrated, so `pnpm lint` / `next lint` fail at option-parsing before linting anything. Not a usable gate.
- **One known-failing test** in `@harvoost/shared` (`RbacScopeService` empty-requesterId) is pre-existing — not a regression.
- Editing `infra/keycloak/realm.json` only re-imports on a **fresh** keycloak volume — `docker compose down -v` (or drop `harvoost-keycloak-data`); a rebuild alone won't re-import.

## Architecture (the parts that span files)

**Layout.** `apps/api` (NestJS 10), `apps/web` (Next.js 14 App Router), `apps/tray` (Electron, unsigned v1); `packages/db` (Prisma 5 schema + migrations + `prisma/seed.ts`), `packages/shared` (RBAC/LLM/TZ libs + `DomainError` types), `packages/jobs` (pg-boss catalogue), `packages/ui` (Tailwind primitives); `tests/contract`, `tests/e2e`. **Postgres 16 is the only persistent store; pg-boss is the queue.**

**RBAC is centralized.** `RbacScopeService` (in `packages/shared`, injected as `RBAC_SCOPE_SERVICE`) is the single cascade-visibility authority: a caller's visible set is the UNION of project-anchored + person-anchored users/projects, applied at the **data layer** for both the API and the chatbot tools. admin/finmgr are unrestricted. Non-visible *and* non-existent both resolve to **404** (never leak existence as 403/500). Cost/rate columns are stripped server-side for non-financial roles.

**Timesheet approvals & period locking.** Two-stage approval with a hard invariant: the stage-1 approver must differ from the stage-2 approver on the same entry. `timesheet_periods` status is a **derived rollup** of its entries (there is no `period_id` FK on entries — the link is computed from `start_at` in the user's TZ). A locked week (submitted/approved) rejects writes both via an app-layer guard *and* a DB `BEFORE INSERT/UPDATE` trigger (closes the TOCTOU race). Future-dating an empty week is always allowed.

**Wire conventions.** All bigint IDs serialize as **decimal strings** (a `BigInt.prototype.toJSON` patch in `apps/api/src/main.ts`); the frontend treats IDs as strings — never `Number()` them. `DomainError` subclasses in `@harvoost/shared` map to HTTP via `HttpExceptionFilter`; note **`ValidationFailedError` → HTTP 400** with a stable machine code in `details.code` (DB constraint conflicts use this pattern, e.g. `TASK_NAME_EXISTS`, rather than 409/422). The append-only `audit_log` is hash-chained.

**Auth is OIDC, provider-agnostic** (ADR-0001): Keycloak in dev, Entra ID in prod — same code path validates `id_token`s against `OIDC_ISSUER_URL`. In Docker the api advertises issuer `http://harvoost.localhost:8080/...` and maps `harvoost.localhost`→host-gateway, while the browser resolves the same host to 127.0.0.1 (`.localhost` TLD magic) — so the `iss` claim matches on both sides without `/etc/hosts` edits. Sessions are HttpOnly cookies (`harvoost_session`); web sends `X-Requested-With` for CSRF.

**FE↔BE drift guard.** `@harvoost/contract` (`tests/contract`) fails if any web `apiFetch` call references a URL/method not declared in `openapi.yaml` or not registered as a NestJS route. The API contract of record is the run's `openapi.yaml` (see below). Live real-time updates use SSE at `GET /v1/sync/events`.

## The `.hacktogether` SDLC workflow

This repo is driven by the **hacktogether** orchestrator (see the `hacktogether` skill). Each run lives in `.hacktogether/runs/<guid>/`:
- `RUN_STATE.md` — the authoritative ledger: phase table, features/incidents table, and a detailed **Decision log** (read this first to understand history and intent).
- Phase folders `01-intake` … `08-docs`; the canonical **`03-api-design/openapi.yaml`** (API contract) and **`02-architecture/ARCHITECTURE.md`** live here.
- `features/FEAT-NNN/` and `incidents/INC-NNN/` — per-change folders (REQUEST, FEATURE_PLAN, HANDOFF_*, reviews) for feature additions and bug fixes, each cross-referenced to a GitHub issue.

When extending the system, follow the contract in `openapi.yaml` and the conventions above rather than inventing new shapes; the contract test will catch drift.
