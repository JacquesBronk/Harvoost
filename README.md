# Harvoost

Internal time-tracking SaaS for a single company (50–500 users). Web dashboards for managers, finance, and admins; an Electron tray companion for employees that handles clock-in plus a daily mood check; a manager chatbot wired to a fixed tool registry; and weekly summary emails. Authentication is OIDC (Keycloak in dev, Microsoft Entra ID in prod). Designed for Azure (South Africa North) but the whole stack runs locally against Docker.

## Features

- Tray clock-in with morning prompt and 1–5 mood capture
- Bi-directional tray/web timer sync with idempotency and DST-aware scheduling
- Per-user IANA timezones; UTC at rest
- Two-stage timesheet approval (manager then financial manager; stage 1 ≠ stage 2 even if one user holds both roles)
- Leave request and approval with a Bamboo sync seam (no-op in v1)
- Manager dashboard with cascade visibility (project-anchored ∪ person-anchored)
- Financial dashboard: revenue, cost, margin per project / team / individual; cost columns stripped server-side for non-financial roles
- Scheduling: defaults, per-user overrides, and broad (project/org) overrides for admins / finance
- Exception detection: missed punch, daily overtime, weekly overtime, anomalies (2σ over trailing 4 weeks)
- Reporting and Harvest-compatible Excel export (sync ≤100k rows, async via job + Blob SAS URL above that)
- RBAC-aware chatbot using the Vercel AI SDK (OpenAI by default; swap to Anthropic / Google / Ollama / xAI by env var) — no free-form SQL; requester identity is bound server-side
- Autonomous Monday-morning weekly summary email per user in their local TZ, with deterministic-template fallback when the LLM is unavailable
- Append-only audit log with HMAC hash chain; 7-year retention

## Architecture at a glance

- TypeScript monorepo (pnpm 9 + Turborepo 2).
- `apps/api` — NestJS 10 on Node 20. RBAC, time entries, approvals, chatbot, reports, SSE sync, pg-boss jobs (12 scheduled).
- `apps/web` — Next.js 14 (App Router). Manager / FinMgr / Admin / Employee dashboards.
- `apps/tray` — Electron 30 cross-platform tray (Win 10+, macOS 12+, Ubuntu 22.04+). Unsigned in v1.
- `packages/{db,shared,jobs,ui}` — Prisma 5 schema (28 tables across 4 migrations), RBAC + LLM + TZ shared lib, pg-boss job catalogue, Tailwind UI primitives.
- Postgres 16 is the only persistent store; pg-boss provides the queue. Azure target via Bicep in `infra/bicep/`.

See the [architecture document](./.hacktogether/runs/87edeba4-9a80-4a73-858b-548fd9026da4/02-architecture/ARCHITECTURE.md) for the full design.

## Prerequisites

- Node.js 20.x (`.nvmrc` pins 20.18.0)
- pnpm 9 (`corepack enable && corepack prepare pnpm@9.12.0 --activate`)
- Docker + Docker Compose (Docker Desktop on Windows / macOS)
- ~3 GB free RAM while the dev stack is running (Postgres + Keycloak + Azurite + Maildev)
- Linux / macOS / WSL2. On WSL2 keep the repo on the Linux filesystem if you can — NTFS is slow.

## Quick start

```bash
git clone <repo-url> Harvoost
cd Harvoost
cp .env.example .env
```

### One-shot bootstrap (recommended first run)

```bash
pnpm setup
```

`pnpm setup` runs `pnpm install`, boots the four dev containers, applies all migrations, seeds the RBAC fixture, and builds the web app. It takes 3–8 minutes the first time depending on network speed.

### Run the stack

The web app's standalone production build is significantly faster than `next dev` on WSL2, so the recommended local-dev path runs the API via `ts-node` and the web via the standalone Node server (built once by `pnpm setup`). Use two terminals:

```bash
# Terminal 1 — API on :3001 (ts-node, decorator metadata preserved)
pnpm dev:api

# Terminal 2 — web on :3000 (production build served by next standalone)
pnpm start:web
```

If you change web code, rebuild before restarting: `pnpm build:web && pnpm start:web`.

`pnpm dev` (root) runs `turbo run dev --parallel`, which boots everything via each package's `dev` script. The web `dev` script uses `next dev`, which is usable but slow on WSL2 + NTFS — prefer the two-terminal flow above.

### Sign in

Open <http://localhost:3000>. Sign-in goes through Keycloak at <http://localhost:8080>. Use one of the seeded test users below (passwords mirrored in `infra/keycloak/README.md`).

## Test users (dev only)

All passwords start with `dev-` so they cannot be confused with production credentials.

| Email | Password | Role in Harvoost |
|---|---|---|
| `admin@harvoost.local` | `dev-admin-pass` | Admin (auto-provisioned by `BOOTSTRAP_ADMIN_EMAIL` on first sign-in) |
| `alice@harvoost.local` | `dev-alice-pass` | Manager — project-anchored to P1, sees Bob + Carol |
| `finmgr@harvoost.local` | `dev-finmgr-pass` | Financial Manager — sees cost and rate columns |
| `bob@harvoost.local` | `dev-bob-pass` | Employee on P1, P2 |
| `carol@harvoost.local` | `dev-carol-pass` | Employee on P1, P4 |
| `dave@harvoost.local` | `dev-dave-pass` | Employee on P2, P3 (not visible to Alice — used for cascade-negative tests) |
| `eve@harvoost.local` | `dev-eve-pass` | Employee with no anchor (used for mood k≥5 anonymity tests) |

## Local service URLs

| Service | URL | Credentials |
|---|---|---|
| Harvoost web | <http://localhost:3000> | see test users |
| Harvoost API health | <http://localhost:3001/v1/health> | none |
| Keycloak admin console | <http://localhost:8080/admin> | `admin` / `dev-admin-not-for-prod` |
| Keycloak realm discovery | <http://localhost:8080/realms/harvoost/.well-known/openid-configuration> | — |
| Maildev (captured outbound email) | <http://localhost:1080> | — |
| Postgres | `postgres://harvoost:dev@localhost:5432/harvoost` | `harvoost` / `dev` |
| Azurite (Blob) | <http://localhost:10000/devstoreaccount1> | well-known dev key |
| Ollama (opt-in, `--profile llm`) | <http://localhost:11434> | — |

## Common commands

| Command | What it does |
|---|---|
| `pnpm setup` | First-time bootstrap (install, compose up, migrate, seed, build web) |
| `pnpm compose:up` | Start Postgres + Azurite + Maildev + Keycloak (detached) |
| `pnpm compose:down` | Stop containers; volumes preserved |
| `pnpm migrate` | `prisma migrate deploy` (applies committed migrations) |
| `pnpm seed` | Re-seed the RBAC fixture (idempotent) |
| `pnpm db:reset` | Drop, re-migrate, re-seed. Destructive — dev only. |
| `pnpm db:studio` | Open Prisma Studio against the dev DB |
| `pnpm dev:api` | Run API in dev (ts-node, port 3001) |
| `pnpm build:web` | Build the web standalone bundle |
| `pnpm start:web` | Serve the standalone web build on :3000 |
| `pnpm test` | Run all unit and integration suites (375 tests across 4 packages) |
| `pnpm typecheck` | `tsc --noEmit` across all 10 packages |
| `pnpm e2e` | Hermetic Playwright suite (mock API) |
| `pnpm e2e:live` | Playwright suite against the live Keycloak + API |
| `pnpm docker:up:llm` | Also boot Ollama (run `docker exec -it harvoost-ollama ollama pull llama3.1` after) |

## Running tests

```bash
# Unit + integration across packages
pnpm test                                                      # 375 tests
pnpm --filter @harvoost/api test                               # API only (222 tests)
pnpm --filter @harvoost/shared test                            # shared lib (92 tests)
pnpm --filter @harvoost/jobs test                              # job lane (40 tests)
pnpm --filter @harvoost/db test                                # migration contract (21 tests)

# Typecheck
pnpm typecheck

# Hermetic Playwright (mocked API; ~71 active specs)
pnpm e2e

# Playwright against the live Docker stack (needs compose up + apps running)
pnpm e2e:live
```

The hermetic e2e suite currently has roughly 45 selector mismatches that are tracked in [`.hacktogether/runs/.../07-deploy/TODO_INVENTORY.md`](./.hacktogether/runs/87edeba4-9a80-4a73-858b-548fd9026da4/07-deploy/TODO_INVENTORY.md) — they are UI-selector drift between specs and the rendered pages, not regressions in business logic.

## Project layout

```
apps/
  api/       NestJS API on :3001 — RBAC, time entries, approvals, chatbot, reports, SSE
  web/       Next.js web on :3000 — manager / finmgr / admin / employee dashboards
  tray/      Electron tray app — clock-in, mood capture, live sync
packages/
  db/        Prisma schema (28 tables, 4 migrations), seed, RBAC fixture
  shared/    RbacScopeService, Luxon TZ helpers, LLM provider abstraction, chatbot tool registry
  jobs/      pg-boss job catalogue (mood retention, weekly summaries, exception detection, ...)
  ui/        Tailwind primitives shared by web + tray
tests/e2e/   Playwright suite (hermetic + live-against-Keycloak)
infra/
  bicep/     Azure IaC for prod deploy
  keycloak/  Dev OIDC realm + seeded users
.hacktogether/runs/<run-id>/   SDLC artifacts from the HackTogether build
```

## Configuration

All environment variables are documented in [`.env.example`](./.env.example). The dev defaults work out of the box with `pnpm setup`. The variables that must change for production are:

- `OIDC_ISSUER_URL` — set to `https://login.microsoftonline.com/<tenant-id>/v2.0` for Entra (see [ADR-0001](./.hacktogether/runs/87edeba4-9a80-4a73-858b-548fd9026da4/02-architecture/ADR-0001-oidc-provider-agnostic.md))
- `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET` — from your Entra App Registration
- `DATABASE_URL` — Azure Postgres connection string (`sslmode=require`)
- `BLOB_STORAGE_CONNECTION_STRING` — Azure Blob connection string
- `APPINSIGHTS_CONNECTION_STRING` — Application Insights
- `OPENAI_API_KEY` — required for the default `LLM_PROVIDER=openai`
- `ACS_EMAIL_CONNECTION_STRING`, `ACS_EMAIL_SENDER_ADDRESS` — Azure Communication Services Email
- `SESSION_SECRET`, `AUDIT_HASH_SECRET` — at least 32 bytes each, and must NOT start with `dev-` (boot invariants refuse the dev defaults in `NODE_ENV=production`)
- `BOOTSTRAP_ADMIN_EMAIL` — the first OIDC login matching this email is auto-provisioned as an admin

## Deploying to Azure

The Bicep IaC and the operator runbook live under [`infra/bicep/`](./infra/bicep/). The predeploy checklist is at [`.hacktogether/runs/.../07-deploy/DEPLOY_READINESS.md`](./.hacktogether/runs/87edeba4-9a80-4a73-858b-548fd9026da4/07-deploy/DEPLOY_READINESS.md).

Summary of the flow:

1. Provision the resource group + Bicep template in `southafricanorth`.
2. Create an Entra App Registration; capture client ID + secret + tenant ID.
3. Populate Key Vault with the secret matrix in `DEPLOY_READINESS.md` § Secrets in Key Vault.
4. Add a federated credential to the App Registration for the GitHub Actions workflow.
5. Deploy via `.github/workflows/deploy.yml` (Container Apps + same image for API and worker, distinguished by `WORKER_MODE=1`).

## Known limitations (v0.1.0)

- The Electron tray ships unsigned in v1 — installers raise SmartScreen (Windows) and Gatekeeper (macOS) warnings. Code-signing is deferred to v1.1.
- BambooHR leave sync is a no-op in v1; the schema + interface are in place for v2.
- Roughly 45 of the hermetic Playwright specs reference selectors that have drifted from the rendered UI; the underlying business logic is exercised by the 375 unit + integration tests. Tracked in `07-deploy/TODO_INVENTORY.md`.
- The `audit-log-integrity` job verifies hash-chain linkage but does not recompute the HMAC (defence-in-depth gap, tracked as v1.0.1). The primary insert path is HMAC-verified by a BEFORE-INSERT trigger.
- A few major-severity items are deferred to v1.0.1: chatbot LLM error message leakage (`M2`), token budget sliding-24h vs local-day (`M3`), and `GET /v1/users/:id` IDOR (`M4`).
- Production Entra ID sign-in is wired and tested against Keycloak in dev; the first real-Entra deploy must verify the discovery doc is reachable from the Container App. See `DEPLOY_READINESS.md` § First-deploy verifications.

The full inventory is in [`07-deploy/TODO_INVENTORY.md`](./.hacktogether/runs/87edeba4-9a80-4a73-858b-548fd9026da4/07-deploy/TODO_INVENTORY.md).

## Troubleshooting

**API exits immediately with `OIDC_ISSUER_URL not set` or boot invariants throwing.** Confirm `.env` exists at the repo root (`cp .env.example .env` if not) and that `pnpm dev:api` was launched from the repo root so `.env` is picked up.

**Web standalone server fails with `ENOENT .next/standalone/apps/web/server.js`.** The standalone build hasn't been produced. Run `pnpm build:web`.

**`pnpm dev:api` errors with "Reflect.getMetadata is not a function" or missing decorator metadata.** Make sure you're using `ts-node` (not `tsx`). The `dev` script in `apps/api/package.json` explicitly uses `ts-node` because `esbuild` (which backs `tsx`) does not emit decorator metadata that NestJS needs.

**Keycloak healthcheck never goes green.** First boot imports the realm and can take 30–45 seconds. Check `docker compose logs keycloak`. If you see a "realm already imported" error after a `docker compose down -v`, the volume may have leftover state — remove it explicitly: `docker volume rm harvoost-keycloak-data`.

**Sign-in redirects to Keycloak then bounces with `OIDC_NONCE_MISMATCH`.** Cookies issued by a previous session are stale. Clear the `harvoost_session` cookie and try again.

**Port 3000 or 3001 already in use.** `lsof -i :3000` and `lsof -i :3001` to find the offending process. The web standalone server reads `PORT` from env; you can override it: `PORT=3002 pnpm start:web`.

**Audit log writes silently fail.** Check `apps/api` logs for `audit_log_insert_failed`. The HMAC trigger requires `app.audit_hash_secret` to be set at the connection level — confirm `AUDIT_HASH_SECRET` is in your `.env` and ≥32 characters.

## Documentation

- [ARCHITECTURE](./.hacktogether/runs/87edeba4-9a80-4a73-858b-548fd9026da4/02-architecture/ARCHITECTURE.md) — system design, data model, RBAC cascade, chatbot tool registry, SSE sync, HMAC audit chain
- [STACK](./.hacktogether/runs/87edeba4-9a80-4a73-858b-548fd9026da4/02-architecture/STACK.md) — pinned versions, every env var, deploy SKUs
- [ADR-0001](./.hacktogether/runs/87edeba4-9a80-4a73-858b-548fd9026da4/02-architecture/ADR-0001-oidc-provider-agnostic.md) — OIDC provider-agnostic decision (Keycloak in dev, Entra in prod)
- [API_NOTES](./.hacktogether/runs/87edeba4-9a80-4a73-858b-548fd9026da4/03-api-design/API_NOTES.md) — endpoint conventions
- [openapi.yaml](./.hacktogether/runs/87edeba4-9a80-4a73-858b-548fd9026da4/03-api-design/openapi.yaml) — OpenAPI 3.1 spec (~55 endpoints)
- [DEPLOY_READINESS](./.hacktogether/runs/87edeba4-9a80-4a73-858b-548fd9026da4/07-deploy/DEPLOY_READINESS.md) — predeploy operator checklist
- [TODO_INVENTORY](./.hacktogether/runs/87edeba4-9a80-4a73-858b-548fd9026da4/07-deploy/TODO_INVENTORY.md) — open items, status of every feature and finding
- [infra/keycloak/README.md](./infra/keycloak/README.md) — dev OIDC IdP, seeded clients and users
- [infra/bicep/README.md](./infra/bicep/README.md) — Azure IaC operator runbook

## License

Internal / proprietary. See `LICENSE` (TBD).
