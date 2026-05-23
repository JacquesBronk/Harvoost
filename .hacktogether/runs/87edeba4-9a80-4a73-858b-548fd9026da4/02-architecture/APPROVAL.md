---
gate: approve_architecture
approved_by: user (euphoria80@gmail.com)
approved_at: 2026-05-22T16:45:09Z
revision: r2
---

# Architecture approval

Approved at gate `approve_architecture` after two revision rounds.

## Final architecture summary

- **Region:** Azure South Africa North primary + South Africa West paired-backup (r1).
- **Stack:**
  - Backend: NestJS 10 (TypeScript on Node 20+ LTS)
  - Frontend: Next.js 14 (App Router, React 18+, Tailwind)
  - Tray: Electron (cross-platform Win 10/11 + macOS 12+ + Ubuntu 22.04+)
  - ORM: Prisma 5
  - Database: Azure Database for PostgreSQL Flexible Server (Postgres 16)
  - Jobs: pg-boss 9 (Postgres-backed; no Redis dependency v1)
  - Email: Azure Communication Services Email (fallback to West Europe if not GA in SAN at deploy time)
  - LLM client: Vercel AI SDK with pluggable providers (OpenAI / Anthropic / Google / Ollama / xAI Grok) (r1).
    - **Default production provider: OpenAI `gpt-4o` (prod), `gpt-4o-mini` (CI/dev)** (r2). `OPENAI_API_KEY` required.
  - Storage: Azure Blob Storage; Audit log hash chain
  - Telemetry: Application Insights via OpenTelemetry
  - IaC: Bicep
  - Monorepo: pnpm workspaces + Turborepo; packages: `apps/web`, `apps/api`, `apps/tray`, `packages/{shared,db,ui,jobs}`
  - Data fetching: TanStack Query + REST (no tRPC, no Next.js server actions; tray shares the contract)
  - RBAC enforcement: service-layer guards + lint rule + integration tests; single `RbacScopeService` as truth source (no Postgres RLS in v1)
  - Auth: Entra ID OIDC; `apps/api` is the session authority

## Data model

**26 tables** (r2; was 24 at r1):
- core: users, projects, clients, time_entries, mood_entries, leave_requests, schedule_templates, schedule_overrides, exceptions, approvals, audit_log, project_managers, user_managers, project_members, employee_cost_rates, project_billable_rates, time_entry_state_history, email_delivery_log, chatbot_tool_invocations, …
- new at r2: `chatbot_conversations`, `chatbot_messages` (own-only RBAC; 30-day retention via prune job)

## Background jobs

**12 jobs** (r2; was 11 at r1):
- new at r2: `chatbot.prune_old_conversations` (cron `0 3 * * *` UTC; deletes conversations where `last_message_at < now() - interval '30 days'`)

## Chatbot endpoint contract (r2 additions)

- `POST /v1/chatbot/messages` — replaces `/ask`; accepts `{ conversation_id?, message }`; returns `{ conversation_id, reply, structured_data, tool_calls[], usage }`.
- `GET /v1/chatbot/conversations` — paginated, **strictly own-only**; not even FinMgr/Manager can see another user's chat history (only Admin for audit, logged).
- `GET /v1/chatbot/conversations/{id}/messages` — same own-only rule.

## Tray distribution

**v1 ships unsigned** — code-signing budget (~$400/yr) deferred to v1.1.
- Windows: SmartScreen warning on install
- macOS: Gatekeeper blocks; users right-click → Open
- Linux: .deb/.AppImage with no signature
- Mitigation: internal install-instructions doc; IT whitelist via Group Policy where applicable
- New risk #19 (L:M, I:M) documented in ARCHITECTURE.md

## Electron CORS strategy

Electron main process holds the bearer token; renderer requests are proxied via IPC to the main process which makes the actual HTTP call. Renderer never makes direct cross-origin requests, avoiding CORS entirely. `CORS_ALLOWED_ORIGINS` env var only needs to list the web app's domain(s).

## All 13 original HITL picks — status

| # | Pick | Status |
|---|------|--------|
| 1 | Backend = NestJS 10 | RESOLVED (approved as proposed) |
| 2 | ORM = Prisma 5 | RESOLVED (approved as proposed) |
| 3 | Jobs = pg-boss 9 | RESOLVED (approved as proposed) |
| 4 | Email = ACS Email | RESOLVED (approved as proposed) |
| 5 | LLM = Claude `sonnet-4-5` | REVISED at r1 → Vercel AI SDK pluggable; at r2 → default OpenAI `gpt-4o` |
| 6 | Monorepo = pnpm + Turborepo | RESOLVED (approved as proposed) |
| 7 | Data fetching = TanStack + REST | RESOLVED (approved as proposed) |
| 8 | IaC = Bicep | RESOLVED (approved as proposed) |
| 9 | RBAC = service-layer + lint + tests | RESOLVED (approved as proposed) |
| 10 | Region = West Europe + N Europe backup | REVISED at r1 → South Africa North + SA West backup |
| 11 | API split = standalone apps/api + apps/web | RESOLVED (approved as proposed) |
| 12 | Session authority = apps/api | RESOLVED (approved as proposed) |
| 13 | Code-signing budget ~$400/yr | RESOLVED at r2 → DEFERRED to v1.1; ship unsigned |

## 4 open questions from r1 — status

| Q | Decision (r2) |
|---|---|
| Code-signing budget | DEFERRED to v1.1; ship unsigned |
| Chatbot conversation persistence | 30 days then prune (new tables + job) |
| Tray API exposure | Public `apps/api` + strict CORS + bearer auth |
| Default LLM for first deploy | OpenAI `gpt-4o` (prod), `gpt-4o-mini` (CI) |

## All 16 intake `[ASSUMED:]` items — status

Per ARCHITECTURE.md § "Validations of intake [ASSUMED:] items": 15 CONFIRMED, 1 REVISED (region changed at r1).

## Risks

19 total (r2):
- Original 16 from REQUIREMENTS.md, all mapped to architectural mitigations
- r1 +2: multi-provider tool-calling drift; multi-provider key sprawl
- r2 +1: unsigned tray install friction

## Approved as-is

Architect's flagged concerns acknowledged. All HITL items resolved. No open questions remain. Ready for api-design phase.
