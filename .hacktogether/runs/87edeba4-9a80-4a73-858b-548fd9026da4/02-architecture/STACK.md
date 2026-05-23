# Stack — harvoost-timetracking

> **Status:** revised (r3 — auth) for HITL acknowledgement.
> **Companion to:** `ARCHITECTURE.md`. Read that first for rationale; this file is the manifest.
> **r1 (2026-05-22):** Azure region → South Africa North; LLM client → Vercel AI SDK (pluggable across OpenAI / Anthropic / Google / Ollama / xAI).
> **r2 (2026-05-22):** Default `LLM_PROVIDER=openai` with `LLM_MODEL_ID=gpt-4o` (prod) / `gpt-4o-mini` (CI/dev). `OPENAI_API_KEY` becomes the required default secret. Code-signing deferred to v1.1 (tray ships unsigned).
> **r3 (2026-05-22):** Auth is provider-agnostic OIDC (Entra in prod, Keycloak in dev). `ENTRA_*` env vars renamed to `OIDC_*` (+ new `OIDC_ISSUER_URL`). `MOCK_OIDC` env var DELETED. See `ADR-0001-oidc-provider-agnostic.md`.

## Language & runtime

| Layer | Choice | Version | Why |
|---|---|---|---|
| Backend runtime | Node.js | 20.x LTS | Long-term support window covers v1 + v2; pg-boss, Prisma, NestJS all first-class on Node 20. |
| Language | TypeScript | 5.4+ | Shared types web ↔ tray ↔ api. Strict mode on. |
| Database | PostgreSQL | 16.x (Azure Database for PostgreSQL Flexible Server) | EXCLUDE constraints, `tstzrange`, generated columns, partial indexes, JSONB — all required for our schema. |
| Package manager | pnpm | 9.x | Content-addressable store for fast CI installs; workspaces for the monorepo. |
| Monorepo tasks | Turborepo | 2.x | Task graph caching keyed to inputs. |

## Backend

| Concern | Library | Version | Why |
|---|---|---|---|
| HTTP framework | NestJS | 10.x | DI, modules, guards (RBAC), interceptors (audit), built-in OpenAPI gen, `@nestjs/schedule`, `@nestjs/throttler`. |
| ORM | Prisma | 5.x | Greenfield-friendly migrations; types flow into shared package; `$queryRaw` escape hatch for the cascade visibility CTE. |
| Job runner | pg-boss | 9.x | Postgres-backed queue + cron + retries; avoids Redis dependency. |
| Validation | Zod | 3.x | Shared between API (DTO parsing), frontend (form validation), and LLM tool schemas (via Vercel AI SDK's `tool()` helper). |
| Date/time | Luxon | 3.x | IANA-aware, DST-tested, immutable. |
| HTTP client | undici (Node fetch) | bundled | Native; used for ACS Email and as the underlying fetch for the AI SDK provider packages. |
| **OIDC client (r3)** | **`jose`** | **5.x** | Provider-agnostic OIDC id_token validation. `createRemoteJWKSet` for JWKS fetch + cache; `jwtVerify` for signature / aud / iss / exp / nbf / nonce checks. Works against Entra (prod) and Keycloak (dev) and any compliant IdP via `OIDC_ISSUER_URL`. |
| **LLM client (r1)** | **Vercel AI SDK (`ai`)** + per-provider plug-ins | **`ai` 3.x** | Provider-agnostic abstraction supporting OpenAI, Anthropic, Google, Ollama, xAI. Tool calling normalised via `tool()` + `generateText({ tools })`. See ARCHITECTURE.md § Chatbot architecture. |
| **LLM provider — OpenAI (DEFAULT r2)** | `@ai-sdk/openai` | latest | **Canonical production provider.** Used when `LLM_PROVIDER=openai`. Default for prod (`gpt-4o`) and CI (`gpt-4o-mini`). |
| LLM provider — Anthropic | `@ai-sdk/anthropic` | latest | Used when `LLM_PROVIDER=anthropic`. Drop-in alternate. |
| LLM provider — Google | `@ai-sdk/google` | latest | Used when `LLM_PROVIDER=google`. |
| LLM provider — Ollama | `ollama-ai-provider` | latest | Community provider; used when `LLM_PROVIDER=ollama` (offline / self-hosted). |
| LLM provider — xAI | `@ai-sdk/xai` | latest | Used when `LLM_PROVIDER=xai`. |
| Email | @azure/communication-email | latest | ACS Email SDK. |
| Blob storage | @azure/storage-blob | latest | Streaming uploads + SAS URL generation. |
| Key Vault | @azure/keyvault-secrets + @azure/identity | latest | Managed-identity flow. |
| App Insights / OpenTelemetry | @opentelemetry/* + @azure/monitor-opentelemetry-exporter | latest | OTel exporter ships to App Insights; vendor-neutral. |
| Logging | pino | 9.x | Structured JSON logs; ships via OTel. |
| XLSX | exceljs | 4.x | Streaming workbook writer (memory bounded for >100k rows). |
| Rate limiter | @nestjs/throttler | latest | In-process token bucket. |
| OpenAPI gen | @nestjs/swagger | latest | Generates OpenAPI from controllers + Zod schemas (via `nestjs-zod`). |

## Frontend (web)

| Concern | Library | Version | Why |
|---|---|---|---|
| Framework | Next.js | 14.x+ (App Router) | RSC for static pages, client components for dashboards and chat. |
| React | React | 18.x | Suspense, concurrent rendering. |
| Styling | Tailwind CSS | 3.x | Utility-first; co-located with components; small prod bundle. |
| Data fetching | TanStack Query | 5.x | Caching, invalidation, optimistic updates uniformly on web + tray. |
| Forms | react-hook-form + Zod | 7.x + 3.x | Lean, accessible, type-safe with Zod schema validation. |
| Charts | recharts | 2.x | Used in financial dashboards and team rollups. |
| Date picker | react-day-picker | 9.x | Headless, Tailwind-friendly. |
| State (UI) | Zustand | 4.x | Tiny; used for chat panel state, sync status, etc. |
| Auth client | (custom) | — | Calls `apps/api/auth/login` redirect; no `next-auth` v1. |

## Tray (Electron)

| Concern | Library | Version | Why |
|---|---|---|---|
| Electron | electron | 30.x | Latest stable; Chromium 124; supports macOS 12+, Win 10+, Ubuntu 22.04+. |
| Builder | electron-builder | 24.x | Multi-platform installer generation. **(r2) Code-signing wiring deferred to v1.1.** v1 binaries are unsigned (see ARCHITECTURE.md § Tray distribution for install consequences). |
| Updater | electron-updater | 6.x | Optional v1.1; v1 ships via GitHub Releases. |
| Renderer | React + Vite | 18 + 5.x | Same component library as web (from `packages/ui`); Vite for fast renderer dev loop. |
| Local DB | better-sqlite3 | 11.x | Offline queue for clock-in actions when network is down. |
| SSE client | eventsource-parser + fetch | latest | Native EventSource doesn't support custom headers; we parse SSE off a fetch stream. The actual call happens in the Electron main process per the r2 CORS strategy (renderer → IPC → main → API). |

## Database / infra

| Concern | Choice | Version |
|---|---|---|
| Postgres extensions | `btree_gist`, `pgcrypto`, `citext` | bundled with PG 16 |
| Migrations | Prisma Migrate | via Prisma 5 |
| Local Postgres | docker `postgres:16-alpine` | — |
| **Local OIDC IdP (r3)** | **docker `quay.io/keycloak/keycloak:25`** | **25.x** |
| Local mock SMTP | `maildev/maildev` | latest |
| Local LLM mock | `wiremock/wiremock` (OpenAI-shaped responses) or local Ollama install | latest / `ollama:0.3+` |
| Local Blob | Azurite | latest |

## Testing

| Layer | Tool | Version |
|---|---|---|
| Unit | Vitest | 2.x |
| Integration (Postgres) | Vitest + Testcontainers-node | 2.x + 10.x |
| E2E web | Playwright | 1.45+ |
| E2E tray | @playwright/electron | 1.45+ |
| API contract | (validated via Zod-derived OpenAPI in CI) | — |
| Mutation testing | Stryker (optional) | — |

## Tooling

| Concern | Tool | Version |
|---|---|---|
| Linter | ESLint | 9.x (flat config) |
| Formatter | Prettier | 3.x |
| Commit lint | commitlint + husky | latest |
| TS path mapping | tsconfig-paths | — |
| TS project refs | tsc --build | bundled |

## Infrastructure (Azure)

**Primary region:** `southafricanorth` (Johannesburg). **Paired backup region:** `southafricawest` (Cape Town).

| Service | SKU (v1) | Region | Notes |
|---|---|---|---|
| Container Apps | Consumption plan, 0.5 vCPU / 1 GiB per replica | `southafricanorth` | Auto-scale 1–5. GA in SAN. `ca-api` has public ingress for tray reachability (r2). |
| Azure Database for PostgreSQL Flexible Server | B2s (2 vCPU / 4 GiB) | `southafricanorth` | Single AZ; geo-redundant backups to `southafricawest`; upgrade to GP_Standard_D2s_v3 if load demands. GA in SAN. |
| Azure Container Registry | Basic | `southafricanorth` | Stores `apps/web` and `apps/api` images. GA in SAN. |
| Azure Key Vault | Standard | `southafricanorth` | Managed-identity access from Container Apps. GA in SAN. |
| Application Insights | Pay-as-you-go | `southafricanorth` | 100% sampling for errors, 25% for traces. GA in SAN. |
| Azure Communication Services Email | Pay-per-use | `southafricanorth` **or fallback `westeurope`** | Connected to a custom domain. **ACS Email regional GA must be verified at deploy time.** If not GA in SAN, the ACS Email resource is provisioned in West Europe and the workload calls cross-region (~150–200ms latency added to outbound email send). Documented in ARCHITECTURE.md § Deployment topology. |
| Azure Blob Storage | Standard GRS | `southafricanorth` | `exports` container for async XLSX. GRS replicates to `southafricawest`. |
| Azure DNS | (if custom domain) | global | A + CNAME records. |

## CI/CD

| Concern | Tool |
|---|---|
| CI runner | GitHub Actions (Ubuntu 22.04) |
| Container build | Docker buildx (multi-arch optional) |
| Infra-as-code | Bicep (Azure native); all `location` defaults = `southafricanorth` |
| Deployment | `az containerapp update` via GitHub Actions OIDC federation (no static service principal credentials in CI) |
| Image registry | Azure Container Registry |
| Branch protection | main branch, 1 review, green CI, no direct push |
| **CI LLM target (r2)** | OpenAI `gpt-4o-mini` (cheapest viable canonical model with reliable tool-calling) |

---

## Required secrets

Grouped by category. The secrets-intake gate must collect these before the build phase. **Bold = critical.**

### Identity / Auth — OIDC (provider-agnostic, r3)

> **(r3) The identity layer is OIDC, full stop.** Provider is selected by `OIDC_ISSUER_URL`. Production = Entra ID (`https://login.microsoftonline.com/<tenant-id>/v2.0`). Dev = Keycloak in docker-compose (`http://localhost:8080/realms/harvoost`). Any spec-compliant OIDC IdP (Auth0, Okta, ZITADEL, Authelia, etc.) works without code changes.
>
> The discovery document is fetched from `${OIDC_ISSUER_URL}/.well-known/openid-configuration` at boot; the JWKS endpoint is resolved from there. id_tokens are validated using `jose` (signature, `iss`, `aud === OIDC_CLIENT_ID`, `exp`, `nbf`, `nonce`).
>
> **The `MOCK_OIDC` env var no longer exists.** Tests use `TEST_AUTH_BYPASS=1` (gated on `NODE_ENV=test`) + a `mintTestSession(userId)` helper instead.

| Env var | Description | Local-dev fallback |
|---|---|---|
| **`OIDC_ISSUER_URL`** | The OIDC IdP's issuer URL. Discovery doc is fetched from `${OIDC_ISSUER_URL}/.well-known/openid-configuration`. Prod (Entra): `https://login.microsoftonline.com/<tenant-id>/v2.0`. Dev (Keycloak): `http://localhost:8080/realms/harvoost`. **Non-secret** in prod (deploy-time env var, NOT a Key Vault entry). | `http://localhost:8080/realms/harvoost` (Keycloak docker-compose) |
| **`OIDC_CLIENT_ID`** | Relying-party client id at the IdP. Prod (Entra): the App Registration's "Application (client) ID". Dev (Keycloak): `harvoost-web` (for `apps/web`) or `harvoost-tray` (for `apps/tray`). | `harvoost-web` |
| **`OIDC_CLIENT_SECRET`** | Confidential-client secret. Prod (Entra): the App Registration's client secret. Dev (Keycloak): not required for public clients; required only if the realm is configured with confidential clients. | (empty for public client) |
| `OIDC_REDIRECT_URI_WEB` | Web app's post-login redirect. Prod: `https://app.<domain>/v1/auth/callback`. Dev: `http://localhost:3000/v1/auth/callback`. | `http://localhost:3000/v1/auth/callback` |
| `OIDC_REDIRECT_URI_TRAY` | Tray's post-login redirect (custom URI scheme). Prod: `harvoost://auth/callback`. Dev: `harvoost-dev://auth/callback`. | `harvoost-dev://auth/callback` |
| ~~`MOCK_OIDC`~~ | **DELETED (r3).** The mock-OIDC mode and the `X-Mock-User-Id` header bypass were removed in favour of the Keycloak dev IdP. Boot invariants around `MOCK_OIDC` are also gone. | — |
| ~~`ENTRA_TENANT_ID`~~ | **DELETED (r3).** The tenant is encoded in `OIDC_ISSUER_URL`. | — |
| ~~`ENTRA_CLIENT_ID`~~ | **RENAMED (r3)** to `OIDC_CLIENT_ID`. | — |
| ~~`ENTRA_CLIENT_SECRET`~~ | **RENAMED (r3)** to `OIDC_CLIENT_SECRET`. | — |

**Test-only:** `TEST_AUTH_BYPASS=1` (gated on `NODE_ENV=test`) enables a `mintTestSession(userId)` helper that writes directly to the `sessions` table. NO HTTP endpoint accepts arbitrary identity from a request body. Boot invariants refuse `TEST_AUTH_BYPASS=1` when `NODE_ENV!=test`.

### Database

| Env var | Description | Local-dev fallback |
|---|---|---|
| **`DATABASE_URL`** | Postgres connection string in libpq format. Includes `sslmode=require` in prod | `postgresql://harvoost:dev@localhost:5432/harvoost?sslmode=disable` (compose Postgres) |
| `SHADOW_DATABASE_URL` | Used by Prisma migrate dev | docker postgres alt schema |

### Storage

| Env var | Description | Local-dev fallback |
|---|---|---|
| **`BLOB_STORAGE_CONNECTION_STRING`** | Azure Blob Storage connection string | Azurite connection string (well-known dev key) |
| `BLOB_EXPORTS_CONTAINER` | Container name for XLSX exports | `exports` |

### Observability

| Env var | Description | Local-dev fallback |
|---|---|---|
| **`APPINSIGHTS_CONNECTION_STRING`** | App Insights ingestion endpoint + key | unset → OTel exporter disabled; logs go to stdout |

### LLM provider — DEFAULT IS OPENAI (r2)

> **(r2) Default deploy uses `LLM_PROVIDER=openai`. `OPENAI_API_KEY` is the REQUIRED secret for the default deploy.** Other provider keys (`ANTHROPIC_API_KEY`, `GOOGLE_GENERATIVE_AI_API_KEY`, `XAI_API_KEY`, `OLLAMA_BASE_URL`) are OPTIONAL — populate them only if `LLM_PROVIDER` is overridden away from `openai`.
>
> **Invariant (enforced at boot):** Exactly ONE of the five provider-key env vars below is populated, AND it matches the value of `LLM_PROVIDER`. If zero or multiple keys are populated, `apps/api` refuses to start with `LLMConfigError`. The secrets-intake gate collects ONLY the key for the chosen provider (default: `OPENAI_API_KEY`).

| Env var | Description | Required when | Local-dev fallback |
|---|---|---|---|
| **`LLM_PROVIDER`** | Active provider: `openai` \| `anthropic` \| `google` \| `ollama` \| `xai` \| `mock` | always | **Default: `openai`.** Or `mock` → `MockLLMProvider` (canned tool-call responses); or `ollama` if local Ollama is installed |
| **`LLM_MODEL_ID`** | Model identifier for the active provider | always (except `mock`) | **Default prod: `gpt-4o`. Default CI/dev: `gpt-4o-mini`.** Per-provider examples: `claude-sonnet-4-5`, `gemini-1.5-pro`, `llama3.1:70b`, `grok-2`. |
| **`OPENAI_API_KEY`** | OpenAI API key | **REQUIRED for default deploy** (`LLM_PROVIDER=openai`) | n/a (use `mock` or `ollama` in dev) |
| `ANTHROPIC_API_KEY` | Anthropic API key | OPTIONAL — only if `LLM_PROVIDER=anthropic` | n/a |
| `GOOGLE_GENERATIVE_AI_API_KEY` | Google AI Studio / Generative Language API key | OPTIONAL — only if `LLM_PROVIDER=google` | n/a |
| `XAI_API_KEY` | xAI API key | OPTIONAL — only if `LLM_PROVIDER=xai` | n/a |
| `OLLAMA_BASE_URL` | Ollama server base URL (e.g., `http://localhost:11434`) | OPTIONAL — only if `LLM_PROVIDER=ollama` | `http://localhost:11434` |

**Tool-calling capability gate:** the chatbot endpoint is enabled only if the active provider/model supports tool calling. The capability matrix lives in `packages/shared/src/llm/capabilities.ts` and is consulted at boot. If disabled, the weekly-summary path still works because it uses `generateText` (no tools). See ARCHITECTURE.md § Chatbot architecture § Tool-calling compatibility per provider.

### Email

| Env var | Description | Local-dev fallback |
|---|---|---|
| **`ACS_EMAIL_CONNECTION_STRING`** | ACS Email resource connection string (resource may be in `southafricanorth` or `westeurope` — caller does not need to know) | unset → MaildevEmailClient (captures to http://localhost:1080) |
| `ACS_EMAIL_SENDER_ADDRESS` | e.g., `noreply@harvoost.example.com` | `noreply@harvoost.local` |

### Sessions

| Env var | Description | Local-dev fallback |
|---|---|---|
| **`SESSION_SECRET`** | HMAC secret for signing session tokens; 32+ bytes random | `dev-session-secret-not-for-prod` |
| **`AUDIT_HASH_SECRET`** | HMAC secret for the audit-log hash chain | `dev-audit-secret-not-for-prod` |

### Bootstrap

| Env var | Description | Local-dev fallback |
|---|---|---|
| **`BOOTSTRAP_ADMIN_EMAIL`** | Email seeded into `admin_email_allowlist` so the first OIDC login auto-provisions an admin | `admin@harvoost.local` (matches the Keycloak realm-import's `alice@harvoost.local` for dev) |

### Other

| Env var | Description | Local-dev fallback |
|---|---|---|
| `NODE_ENV` | `development` \| `production` \| `test` | `development` |
| `WORKER_MODE` | `1` if this process is the pg-boss worker (no HTTP) | unset → API mode |
| `PORT` | HTTP port for `apps/api` | `3001` |
| **`CORS_ALLOWED_ORIGINS`** (r2) | Comma-separated CORS allowlist for `ca-api`. **Only the web app origin** (e.g., `https://app.harvoost.example.com`). The tray does NOT need an entry — it calls the API from the Electron main process via Node `fetch`, not from the renderer, so browser-CORS does not apply. | `http://localhost:3000` |
| `WEB_ORIGIN` | (legacy alias for `CORS_ALLOWED_ORIGINS`; the build phase may consolidate) | `http://localhost:3000` |
| `REDIS_URL` | OPTIONAL v1.1; unset means rate limiter is in-process | unset |

### Local-dev secrets summary (r3)

| Secret | If absent, dev experience is… |
|---|---|
| `OIDC_ISSUER_URL` + `OIDC_CLIENT_ID` | **(r3) Defaults point at Keycloak in docker-compose** (`http://localhost:8080/realms/harvoost` + `harvoost-web`). The realm import seeds Alice/Bob/Carol/Dave fixture users (matching `packages/db/prisma/seed.ts`). Real OIDC handshake exercised in dev — same code path as production. **There is no mock-OIDC mode.** |
| `DATABASE_URL` | App fails to boot — Postgres is mandatory even in dev. |
| `LLM_PROVIDER` + provider key | **(r2) Recommended dev path: install Ollama locally for offline work**, set `LLM_PROVIDER=ollama`, `OLLAMA_BASE_URL=http://localhost:11434`, `LLM_MODEL_ID=llama3.1` (or `qwen2.5`). **Production default is OpenAI** (`LLM_PROVIDER=openai`, `LLM_MODEL_ID=gpt-4o`); CI uses `gpt-4o-mini` against the real OpenAI API for cost. If `LLM_PROVIDER=mock` (or unset), chatbot uses canned responses and weekly summary uses template-only output. Note: smaller Ollama models may not reliably tool-call — the chatbot endpoint will surface `enabled=false` in that case, but weekly summary still works. |
| `ACS_EMAIL_CONNECTION_STRING` | Emails captured to Maildev at http://localhost:1080 instead of sent. |
| `BLOB_STORAGE_CONNECTION_STRING` | Falls back to Azurite at http://localhost:10000. Async XLSX export still works. |
| `APPINSIGHTS_CONNECTION_STRING` | OTel disabled; logs to stdout. |
| `BOOTSTRAP_ADMIN_EMAIL` | First user can't be auto-provisioned as admin — must be added manually to the allowlist. Default value `admin@harvoost.local` is what the Keycloak realm import seeds for Alice. |

---

## Deviations from playbook default

The phase playbook's default stack is "FastAPI + Postgres + minimal React (Vite) + Docker compose". This project deviates as follows; each deviation is justified in `ARCHITECTURE.md` (and flagged for HITL approval).

| Deviation | Reason |
|---|---|
| Node/TypeScript backend instead of Python/FastAPI | The Electron tray and web frontend need to share types and business-rule logic (RBAC scope, validation). A TypeScript-first stack eliminates an entire class of drift. |
| NestJS instead of FastAPI-equivalent (Fastify) | The number of cross-cutting concerns (RBAC, audit, scheduling, OTel) is large enough that the DI + module framework pays for itself. |
| Next.js instead of "minimal React + Vite" | The dashboards have heavy React + data fetching needs; App Router gives us SSR for static pages + RSC for partial pre-rendering. Vite+React would work but Next.js is the better fit at this scale. |
| Prisma instead of raw SQL or Drizzle | Migration ergonomics + type generation for the shared package. |
| pg-boss instead of an in-process scheduler | We have multiple recurring jobs + ad-hoc dispatched jobs (XLSX export); a real queue is needed. Postgres-backed avoids Redis dependency. |
| Azure deployment (not raw docker-compose) | Requirements specify Azure-native deployment. |
| Vercel AI SDK instead of a single-vendor LLM SDK (r1) | The user required a pluggable LLM provider abstraction supporting OpenAI / Anthropic / Google / Ollama / xAI. The Vercel AI SDK is the only mainstream TypeScript library that normalises tool calling across that set. **(r2) Default `LLM_PROVIDER=openai`** — but the abstraction stands so the org can swap providers without code changes. |
| **(r3) `jose` + Keycloak-in-dev + provider-agnostic OIDC env vars instead of Entra-only + mock-OIDC mode** | OIDC is provider-agnostic by spec. Using Keycloak in dev exercises the SAME real-OIDC code path that production runs against Entra — resolves F3 (real Entra OIDC TODO) + B3 (mock-OIDC active-debug-code risk) + dev/test ergonomics in one implementation. See `ADR-0001-oidc-provider-agnostic.md`. |

These are explicitly approved by the requirements (intake handoff calls out "TypeScript-first stack (Node + Postgres + Next.js + Electron) is the natural fit") — they are not unilateral architect changes. The phase playbook's default is just not appropriate for this project's constraints.
