---
phase: architecture
agent: architect
started: 2026-05-22T14:10:00Z
finished: 2026-05-22T16:42:00Z
status: complete (revision 2)
---

# Summary

Revision 2 of the Harvoost architecture. The user resolved the 4 open questions left over from r1 at the HITL gate, and this revision folds those 4 decisions into ARCHITECTURE.md + STACK.md as surgical patches. (A) **Tray code-signing is DEFERRED to v1.1** — v1 tray binaries ship UNSIGNED; install consequences (SmartScreen warning on Windows, Gatekeeper block on macOS, no signature on Linux) are documented along with an install-instructions doc + optional IT Group Policy / MDM whitelist as the v1 mitigation. (B) **Chatbot conversations are persisted for 30 days then pruned** — two new tables (`chatbot_conversations`, `chatbot_messages`) bring the data model to 26 tables; one new pg-boss job (`chatbot.prune_old_conversations`, daily 03:00 UTC) brings the catalogue to 12 jobs; the chatbot HTTP contract is updated with a `conversation_id` field on the message-post endpoint plus two new GET endpoints for listing own conversations and own messages — both strictly own-only (FinMgr / Manager cannot read another user's chat history even within their RBAC scope). (C) **Tray API is publicly exposed on `ca-api`** with strict CORS (only the web app origin) and bearer-token auth; the Electron renderer never directly calls the API — the bearer token lives in the main process and the renderer proxies via IPC, which keeps `CORS_ALLOWED_ORIGINS` tight and removes the bearer-token exfiltration risk if the renderer is compromised. (D) **Default LLM provider locked to OpenAI** — `LLM_PROVIDER=openai`, `LLM_MODEL_ID=gpt-4o` (prod) / `gpt-4o-mini` (CI/dev); `OPENAI_API_KEY` becomes the required default secret; other provider keys move to "optional, only if `LLM_PROVIDER` changes"; the chatbot compatibility table marks OpenAI as canonical. One new risk (#19: unsigned tray install friction, L:M I:M) is added. All r1 content stands; no other changes.

# Files touched

- /mnt/c/Projects/Harvoost/.hacktogether/runs/87edeba4-9a80-4a73-858b-548fd9026da4/02-architecture/ARCHITECTURE.md (modified — revision history line for r2 added; HITL item 13 (code-signing) re-cast as RESOLVED-DEFERRED; HITL item 5 (LLM) annotated with r2 OpenAI default; data model section grew from 24 to 26 tables; pg-boss catalogue grew from 11 to 12 jobs; chatbot architecture section: 3 endpoint contract changes (`POST /v1/chatbot/messages`, `GET /v1/chatbot/conversations`, `GET /v1/chatbot/conversations/:id/messages`) + own-only RBAC rule + persistence + 30-day retention + new conversation-ownership orchestrator step; provider compatibility table marks OpenAI as "canonical"; deployment topology: unsigned-tray install caveats + Electron CORS strategy (renderer → IPC → main → API); risk register: new risk #19 (unsigned tray install friction); revision-request 2 block appended at the bottom)
- /mnt/c/Projects/Harvoost/.hacktogether/runs/87edeba4-9a80-4a73-858b-548fd9026da4/02-architecture/STACK.md (modified — top-of-file r2 line; OpenAI provider row marked DEFAULT; tray builder row notes "code-signing wiring deferred to v1.1"; required secrets: OpenAI now REQUIRED for default deploy, other provider keys marked OPTIONAL; new `CORS_ALLOWED_ORIGINS` env var documented as web-origin-only; local-dev secrets summary clarifies prod default vs Ollama for offline dev; CI LLM target locked to `gpt-4o-mini`)
- /mnt/c/Projects/Harvoost/.hacktogether/runs/87edeba4-9a80-4a73-858b-548fd9026da4/02-architecture/HANDOFF.md (modified — this file)

# What downstream agents need to know

## HITL items resolution summary (13 originals + 2 r1 revisions + 4 r2 resolutions — ALL RESOLVED)

Original 13 HITL picks (from r0) — status as of r2:

1. **Backend framework: NestJS 10** — RESOLVED (r0).
2. **ORM: Prisma 5** — RESOLVED (r0).
3. **Job runner: pg-boss 9** — RESOLVED (r0).
4. **Email provider: ACS Email** (with possible `westeurope` fallback) — RESOLVED (r0/r1).
5. **LLM provider abstraction** — REVISED (r1) → Vercel AI SDK pluggable; **r2 default locked = OpenAI `gpt-4o` prod / `gpt-4o-mini` CI**. RESOLVED.
6. **Monorepo: pnpm + Turborepo** — RESOLVED (r0).
7. **Data-fetching: TanStack Query + REST** — RESOLVED (r0).
8. **Infra-as-code: Bicep** — RESOLVED (r0).
9. **RBAC: service-layer + lint + tests** — RESOLVED (r0).
10. **Region** — REVISED (r1) → South Africa North primary + South Africa West paired backup. RESOLVED.
11. **API split: standalone `apps/api` + `apps/web`** — RESOLVED (r0).
12. **Session authority: `apps/api`** — RESOLVED (r0).
13. **Tray code-signing** — **RESOLVED-DEFERRED (r2)**: deferred to v1.1; v1 ships unsigned with install-instructions doc.

r1 additional revisions — status:
- **(r1) Multi-provider LLM abstraction** (item 5 above) — RESOLVED in r2 with OpenAI as canonical default.
- **(r1) Region SA North** (item 10 above) — RESOLVED in r1.

r2 resolutions of the 4 r1-open questions:
- **Q2: Code-signing budget** — RESOLVED-DEFERRED. v1.1 work item.
- **Q3: Tray API exposure** — RESOLVED. Public + strict CORS + bearer + Electron-preload IPC proxy.
- **Q4: Chatbot conversation persistence** — RESOLVED. 30-day retention, nightly prune, strictly own-only.
- **Q5: Canonical LLM provider** — RESOLVED. OpenAI `gpt-4o` (prod) / `gpt-4o-mini` (CI/dev).

## Critical constraints for api-designer (phase 3) — UPDATED (r2)

- The endpoint catalogue in ARCHITECTURE.md § "API surface" is the authoritative list. **(r2) New / changed chatbot endpoints to lock into OpenAPI:**
  - `POST /v1/chatbot/messages` — body `{ conversation_id?: string, message: string }`; returns `{ conversation_id: string, reply: string, structured_data?: object, tool_calls: ToolCall[], usage: { tokens_in, tokens_out }, provider: string, model: string }`. Creates a new conversation when `conversation_id` is absent; appends to an existing one when present (404 if conversation is not owned by requester). This REPLACES the prior `POST /v1/chatbot/ask`.
  - `GET /v1/chatbot/conversations` — cursor-paginated list of REQUESTER'S OWN conversations (newest first by `last_message_at`). **Strictly own-only** regardless of role — FinMgr and Manager cannot list another user's conversations.
  - `GET /v1/chatbot/conversations/:id/messages` — cursor-paginated chronological messages within one conversation. Returns 404 (not 403) if `conversation.user_id != requester.user_id` (uniform 404 prevents leaking the conversation's existence).
  - `GET /v1/chatbot/capabilities` — unchanged from r1: `{ enabled, reason?, provider, model }`.
- Every endpoint that returns scope-bearing data must use the `RbacScopeService.getVisibleUserIds()` / `.getVisibleProjectIds()` filters. The chatbot conversation endpoints are an exception — they use the simpler `user_id = requester.user_id` filter (own-only) and DO NOT consult `RbacScopeService` for cross-user visibility.
- The cost-stripping rule applies to BOTH reports AND the export. Make it a DTO concern (discriminated union or `withFinancialColumns` schema variant).
- `Idempotency-Key` header is REQUIRED on `POST /v1/time-entries/start`, `.stop`, `.switch`. Document explicitly.
- Pagination: cursor-based for time-entries, audit-log, exceptions, **(r2) chatbot conversations + chatbot messages**; offset-based for users, projects.
- Error response shape: `{ code, message, details? }`. The set of codes includes `CHATBOT_DISABLED` (when the active LLM provider doesn't support tool calling).
- All ISO-8601 date/time inputs MUST include explicit offset.
- Every response that's RBAC-scoped should include `scope_size_meta: { visible_users, visible_projects }` for client empty-state UX.

## Critical constraints for database-admin (build phase) — UPDATED (r2)

- Init migration creates extensions: `btree_gist`, `pgcrypto`, `citext`.
- All EXCLUDE constraints are in the init migration (the time-entry `(user_id, time_range)` GIST exclusion is load-bearing).
- Hash-chain trigger on `audit_log` is in the init migration.
- `time_entries.time_range` is `GENERATED ALWAYS AS ... STORED` — needs raw SQL or `Unsupported(...)` in Prisma.
- Partial unique indexes (`time_entries.idempotency_key`, `time_entries.status='running'`) need raw migration steps.
- pg-boss bootstraps its own schema on first connection; grant the app role `CREATE` on the database.
- **(r2) Two NEW tables in the init migration — bringing the model to 26 tables:**
  - `chatbot_conversations`: PK, `user_id` FK→`users(id)` NOT NULL, `started_at` TIMESTAMPTZ NOT NULL DEFAULT NOW(), `last_message_at` TIMESTAMPTZ NOT NULL DEFAULT NOW(), `metadata` JSONB NOT NULL DEFAULT `'{}'::jsonb`. Indexes: `(user_id, last_message_at DESC)`, `(last_message_at)` for the nightly prune scan.
  - `chatbot_messages`: PK, `conversation_id` FK→`chatbot_conversations(id)` **ON DELETE CASCADE** NOT NULL, `role` TEXT NOT NULL CHECK (`role` IN (`'user'`,`'assistant'`,`'tool'`)), `content` TEXT, `tool_name` TEXT, `tool_call_id` TEXT, `tool_input` JSONB, `tool_output` JSONB, `tokens_in` INT, `tokens_out` INT, `created_at` TIMESTAMPTZ NOT NULL DEFAULT NOW(). Index: `(conversation_id, created_at)`.
  - The PK type for both tables: architectural intent in ARCHITECTURE.md uses UUID; database-admin should match the existing convention if `BIGSERIAL` is the prevailing pattern (`users.id` is BIGINT), or lock UUID v7 if the team prefers — flag at migration review.
- `chatbot_tool_invocations` table is UNCHANGED (still captures `_meta: { provider, model }` in `tool_params` JSONB).

## Critical constraints for build phase (orchestrator selects builders) — UPDATED (r2)

- Use one NestJS module per logical component in ARCHITECTURE.md § "Logical components". The Chatbot module now owns the conversation persistence + the new endpoints.
- The chatbot tool registry MUST curry `requesterId` at registration — NEVER part of the JSON schema the LLM sees. Holds across all five providers via Vercel AI SDK's `tool()`.
- `LLMProvider` interface + boot-time factory live in `apps/api/src/llm/`. `MockLLMProvider` is the test-time implementation. **(r2) Default factory selects `@ai-sdk/openai` against `OPENAI_API_KEY` + `gpt-4o`/`gpt-4o-mini`.**
- All scheduled jobs must be idempotent (check `pg_boss.archive` or use unique business keys).
- Default schedule template insertion is part of the user-creation transaction.
- ESLint rule: any Prisma query against `time_entries`, `mood_entries`, `leave_requests`, `exceptions` without a `userId: { in: ... }` or `projectId: { in: ... }` filter must fail the build (with sanctioned `withSelfScope()` whitelist).
- **(r2) The pg-boss catalogue is 12 jobs.** The new `chatbot.prune_old_conversations` (cron `0 3 * * *`) deletes `chatbot_conversations` where `last_message_at < NOW() - INTERVAL '30 days'`. Messages cascade. Logs `chatbot.pruned_conversations` gauge to App Insights.
- **(r2) Chatbot service must persist conversations.** On every `POST /v1/chatbot/messages`:
  1. Resolve conversation (load + own-check OR create new).
  2. Load prior messages chronologically; truncate oldest if total tokens exceed model context window.
  3. Build registry with curried `requesterId`; call provider with prior messages + new user message.
  4. Persist user, assistant, and tool rows to `chatbot_messages` within a transaction.
  5. UPDATE `chatbot_conversations.last_message_at = NOW()`.
  6. Return `{ conversation_id, reply, structured_data, tool_calls[], usage, provider, model }`.

## Constraints for tester (phase 5) — UPDATED (r2)

- The Alice/Bob/Carol/Dave fixture is the canonical RBAC test fixture.
- DST edge tests live in `packages/shared/src/tz/__tests__/dst-edges.test.ts`. `Africa/Johannesburg` does not observe DST.
- Chatbot must be tested with prompt-injection attempts — they must NOT widen scope.
- Cost-stripping must be asserted on both report and export endpoints.
- **(r1) Provider-swap test** — assert RBAC outcomes are stable across mocked provider response shapes.
- **(r2) Conversation-ownership test** — Manager Bob MUST receive 404 when GETting Alice's conversation messages even though Bob can see Alice's time entries via RBAC.
- **(r2) Prune-job test** — insert a conversation aged 31 days, run `chatbot.prune_old_conversations`, assert conversation + messages are deleted.
- **(r2) Renderer-CORS test** (tray E2E) — Playwright `evaluate` in the renderer context proves direct `fetch` to the API URL is CORS-blocked; the IPC bridge is the only working path.
- **CI E2E LLM target:** **OpenAI `gpt-4o-mini`** (r2-locked).

## Constraints for devops (phase 7) — UPDATED (r2)

- Bicep modules live in `infra/bicep/`. Modules: `main.bicep`, `postgres.bicep`, `container-apps.bicep`, `key-vault.bicep`, `app-insights.bicep`, `blob.bicep`, `acs-email.bicep`.
- Primary region = `southafricanorth`; paired = `southafricawest`.
- `acs-email.bicep`'s `acsEmailLocation` defaults to `southafricanorth`, falls back to `westeurope` if not GA at deploy time.
- `BOOTSTRAP_ADMIN_EMAIL` is a deploy-time variable.
- First deploy requires manual Entra App Registration.
- GitHub Actions uses OIDC federation to Azure.
- Single region acknowledged; paired-region is for geo-redundant backups only.
- **(r2) Tray ships UNSIGNED in v1.** devops MUST ship an `install-instructions.md` (or equivalent doc) alongside every GitHub Release with annotated screenshots of:
  - Windows: SmartScreen "Don't run" warning → "More info" → "Run anyway" override.
  - macOS: Gatekeeper "developer cannot be verified" block → right-click → Open OR System Settings → Privacy & Security → "Open Anyway".
  - Linux: GPG checksum verification command for the `.deb` / `.AppImage`.
  - IT distribution guidance: Intune / Group Policy whitelist for Windows; MDM profile for macOS once a stable developer identity is procured (v1.1).
- **(r2) `CORS_ALLOWED_ORIGINS` env var on `ca-api` = ONLY the web app origin** (e.g., `https://app.harvoost.example.com`). The tray does NOT need an entry — main-process Node `fetch` is not subject to browser CORS.
- **(r2) `OPENAI_API_KEY` is the REQUIRED LLM secret** for the default deploy (`LLM_PROVIDER=openai`). Other provider keys are optional.

## Secrets-intake gate inputs — UPDATED (r2)

The full grouped list is in STACK.md § "Required secrets". Critical ones for the default deploy:

- `ENTRA_TENANT_ID`, `ENTRA_CLIENT_ID`, `ENTRA_CLIENT_SECRET`
- `DATABASE_URL`
- `BLOB_STORAGE_CONNECTION_STRING`
- `APPINSIGHTS_CONNECTION_STRING`
- **(r2 default) `LLM_PROVIDER=openai`, `LLM_MODEL_ID=gpt-4o`, `OPENAI_API_KEY`** — REQUIRED.
- Other LLM provider keys (`ANTHROPIC_API_KEY`, `GOOGLE_GENERATIVE_AI_API_KEY`, `XAI_API_KEY`, `OLLAMA_BASE_URL`) — OPTIONAL, only required if `LLM_PROVIDER` is overridden away from `openai`.
- `ACS_EMAIL_CONNECTION_STRING` (+ `ACS_EMAIL_SENDER_ADDRESS`)
- `SESSION_SECRET`
- `AUDIT_HASH_SECRET`
- `BOOTSTRAP_ADMIN_EMAIL`
- `CORS_ALLOWED_ORIGINS` (web app origin only)

# Open questions / unknowns

None — all HITL items resolved at gate r2; ready for `approve_architecture` APPROVAL.md.

# Verification evidence

- File present: /mnt/c/Projects/Harvoost/.hacktogether/runs/87edeba4-9a80-4a73-858b-548fd9026da4/02-architecture/ARCHITECTURE.md — modified via Write (no error). r2 revision history line at top; `chatbot_conversations` + `chatbot_messages` tables present in § Data model with "26 tables (r2)" header; `chatbot.prune_old_conversations` present in § Background job architecture with "Job catalogue (12 jobs, r2)" header; HITL item 13 marked RESOLVED-DEFERRED; provider compatibility table marks OpenAI as "canonical (r2)"; risk #19 added to risk register; § Revision request 2 block appended at the bottom AFTER the existing § Revision request 1 block.
- File present: /mnt/c/Projects/Harvoost/.hacktogether/runs/87edeba4-9a80-4a73-858b-548fd9026da4/02-architecture/STACK.md — modified via Write (no error). Top-of-file r2 line present; OpenAI row marked DEFAULT; `OPENAI_API_KEY` marked **REQUIRED for default deploy**; other LLM provider keys marked OPTIONAL; `CORS_ALLOWED_ORIGINS` documented as web-origin-only; tray builder row notes "code-signing wiring deferred to v1.1"; CI LLM target locked to `gpt-4o-mini`.
- File present: /mnt/c/Projects/Harvoost/.hacktogether/runs/87edeba4-9a80-4a73-858b-548fd9026da4/02-architecture/HANDOFF.md — this file.
- Surgical-change discipline confirmed: items 1, 2, 3, 4, 6, 7, 8, 9, 11, 12 of the original HITL list unchanged; item 5 annotated with r2 default; item 10 unchanged from r1; item 13 re-cast as RESOLVED-DEFERRED; all 24 r1 tables unchanged (2 new tables added → 26 total); all 11 r1 jobs unchanged (1 new job added → 12 total); 16 intake [ASSUMED:] items unchanged (A2 row updated to RESOLVED-DEFERRED); 18 r1 risks unchanged, risk #19 added; the 13-tool chatbot registry unchanged; the curried-`requesterId` trust model unchanged.
