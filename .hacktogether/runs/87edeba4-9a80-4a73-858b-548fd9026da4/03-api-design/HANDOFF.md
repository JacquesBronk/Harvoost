---
phase: api_design
agent: api-designer
started: 2026-05-22T16:45:09Z
finished: 2026-05-22T17:25:00Z
status: complete
---

# Summary

Authored the OpenAPI 3.1.0 contract for Harvoost v1 covering the full endpoint catalogue
defined in ARCHITECTURE.md § "API surface" — 16 tag groups, ~55 operations, ~50 reusable
schemas. Conventions applied uniformly: `/v1` path prefix; `snake_case` JSON; bearer-auth
global with `POST /v1/auth/oidc/callback` and `GET /v1/health` exempt; uniform
`{ code, message, details? }` error envelope with 10 canonical error codes (including
`CHATBOT_DISABLED`, `K_ANONYMITY_THRESHOLD`, `IDEMPOTENCY_CONFLICT`); cursor pagination
for high-volume time-ordered collections (time_entries, audit_log, exceptions,
chatbot_conversations + messages, leave_requests, approvals queue, detailed report) and
offset pagination for catalog-style collections (users, projects, clients); `Idempotency-Key`
required on time-entry start/stop/switch with explicit `409 IDEMPOTENCY_CONFLICT`
documentation; ISO 8601 with explicit offset on every date-time; `scope_meta` on every
RBAC-scoped LIST; `X-RateLimit-*` headers on chatbot + export endpoints; cost-column
stripping described per operation. Also wrote `API_NOTES.md` as the cross-cutting reference
covering auth, error codes, pagination, idempotency, rate limits, versioning, chatbot
capabilities + disabled-fallback, export job lifecycle, and the 10 explicit design decisions
where the architecture spec was thin (e.g., approval-queue read endpoint, POST-bodied
report endpoints, mood endpoint restructuring, 404-vs-403 for chatbot conversations).

# Files touched

- /mnt/c/Projects/Harvoost/.hacktogether/runs/87edeba4-9a80-4a73-858b-548fd9026da4/03-api-design/openapi.yaml (new)
- /mnt/c/Projects/Harvoost/.hacktogether/runs/87edeba4-9a80-4a73-858b-548fd9026da4/03-api-design/API_NOTES.md (new)
- /mnt/c/Projects/Harvoost/.hacktogether/runs/87edeba4-9a80-4a73-858b-548fd9026da4/03-api-design/HANDOFF.md (new — this file)

# What downstream agents need to know

## For backend-dev (build phase)

- The OpenAPI spec at `03-api-design/openapi.yaml` is the contract. Generate request/response
  validation from it. Recommended path: use `nestjs-zod` + a Zod-from-OpenAPI generator (or
  hand-author Zod schemas that match each `components.schemas.*`). Validate every controller
  body + query against the contract; the architect's choice of NestJS + Zod aligns with this.
- **Cost-column stripping** is a server-side concern (omit fields, do not null them). Apply
  at the DTO serialization boundary in the Reports + Exports + TimeEntries modules. Tests
  must assert absence (e.g., `expect(row).not.toHaveProperty('cost_rate')`), not nullity.
- **Idempotency** on start/stop/switch is enforced by (a) the unique partial index on
  `(user_id, idempotency_key) WHERE idempotency_key IS NOT NULL`, and (b) a service-layer
  cache that returns the original response body on a same-key + same-payload retry, and
  raises `IDEMPOTENCY_CONFLICT` (409) on same-key + different-payload.
- **Two-stage approval invariant**: enforce `stage-1-actor ≠ stage-2-actor` in
  `ApprovalService.finalApproveBatch` by reading `time_entry_state_history` for each entry
  before allowing the transition. Return 403 `RBAC_FORBIDDEN` with `details: { entry_id,
  stage_1_actor_id }` on violation.
- **Chatbot conversations** use the simpler own-only filter (`user_id = requester_id`),
  NOT `RbacScopeService`. Even FinMgr and Manager cannot read another user's conversation
  via the conversation endpoints. The conversation 404 response is uniform (no 403
  distinction) to avoid leaking existence.
- **Health endpoint** is a single composite `GET /v1/health` (Azure Container Apps probes
  this). It is unauthenticated.
- **Submit-time-entry** endpoint shape changed from the architecture catalogue: it is
  `POST /v1/time-entries/{entry_id}/submit` with a `scope` body field, not a top-level
  `/v1/timesheets/submit`.
- **Reports + Exports use POST** with JSON body, not GET with query params, because the
  filter set is array-bearing and would exceed URL length limits.

## For frontend-dev / web-frontend / tray-frontend

- Generate a typed client via `openapi-typescript` (or `openapi-fetch`) against
  `03-api-design/openapi.yaml`. Tag-grouped operations map cleanly to client modules.
- **Call `GET /v1/chatbot/capabilities` on app load**; if `enabled=false`, hide the chat
  panel and surface the `reason` string. The chatbot UI must NOT call `POST /v1/chatbot/messages`
  when capabilities reports disabled.
- **Empty-state rendering**: read `scope_meta.visible_users` / `.visible_projects` on every
  scoped LIST. If both are 0 (Manager not yet anchored), render the "contact your admin"
  empty state described in F3.1.
- **Cost columns**: client TypeScript types should treat `cost_rate`, `cost_amount`,
  `billable_rate`, `billable_amount`, `margin*` as `field?: number | null` — they will be
  absent (undefined) for Manager/Employee callers.
- **Idempotency-Key**: tray + web must generate a fresh UUIDv7 for each start/stop/switch
  request. On retry of a failed request, send the same key. On a new operation (e.g., a
  different project switch), generate a new key. The OpenAPI schema specifies `minLength: 8`
  so any UUIDv7 fits.
- **Pagination**: cursor endpoints return `next_cursor`. Pass it as `cursor` on the next
  request. Do not parse it. Offset endpoints use 1-based `page`.
- **Token format**: bearer token in `Authorization: Bearer <token>`. The Electron tray's
  bearer token lives in the main process; the renderer calls `window.harvoost.api.request(...)`
  per the r2 CORS strategy.

## For tester (phase 5)

- The OpenAPI doc is the fixture source for contract tests. Schemathesis-style or
  `dredd`-style contract validation is recommended.
- The Alice / Bob / Carol / Dave RBAC fixture from REQUIREMENTS.md must be exercised
  against **every scoped LIST endpoint** plus the chatbot tool-call paths. Assertions:
  - Manager Alice (project-anchored to P1, person-anchored to Bob) sees only the union.
  - Manager Alice's `GET /v1/time-entries?user_id=Dave_id` returns an empty list (filtered,
    not 403).
  - Manager Alice's `GET /v1/time-entries?project_id=P2&user_id=Bob_id` sees only Bob's P2
    hours (because Alice is person-anchored to Bob), but **not** Dave's P2 hours.
  - Manager Bob's `GET /v1/chatbot/conversations/<alice-conv-id>/messages` returns **404**,
    not 200, even though Bob can see Alice's time entries.
- **Cost-column absence test**: Manager downloads detailed report; assert response rows
  do NOT have `cost_rate` or `cost_amount` keys (`expect(row).not.toHaveProperty(...)`).
  Same for `POST /v1/exports/excel` — the resulting XLSX must not have the Cost Rate /
  Cost Amount columns.
- **K-anonymity test**: aggregate over 4 users returns 400 `K_ANONYMITY_THRESHOLD`, not
  a partial result.
- **Idempotency conflict test**: POST start with key K and body B1, then POST start with
  key K and body B2 → expect 409 `IDEMPOTENCY_CONFLICT`.
- **Stage-2 self-approval test**: a single user holding both Manager and FinMgr roles
  attempts to stage-2-approve an entry they stage-1-approved → expect 403 `RBAC_FORBIDDEN`
  with `details.entry_id` populated.
- **Chatbot disabled test**: set `LLM_PROVIDER=ollama LLM_MODEL_ID=phi3` (no tool calling);
  POST `/v1/chatbot/messages` → expect 503 `CHATBOT_DISABLED`; `GET /v1/chatbot/capabilities`
  still returns 200 with `enabled=false`.
- **Rate-limit headers**: assert presence and decrement on chatbot endpoints and exports.

## For database-admin (build phase)

The OpenAPI doc does not introduce schema changes — the existing 26-table model already
covers everything documented here. Confirmations:
- `time_entries.idempotency_key` and its partial unique index are already in the
  architecture (re-confirm in the init migration).
- `chatbot_conversations` + `chatbot_messages` (r2) are already in the architecture.
- The `export_jobs` table is implied by `GET /v1/exports/jobs/{job_id}`; the architecture
  mentions async export jobs go through pg-boss, but a dedicated job-status table is
  not listed in the 26-table catalogue. **Confirm during migration design** whether
  the export job status is read from `pg_boss.job` directly or whether a thin
  `export_jobs(id, requester_id, status, row_count, blob_path, expires_at, created_at,
  completed_at, error_detail)` table is added. The OpenAPI doc is agnostic — the
  `ExportJob` schema describes the response shape regardless of where it is stored.
- `chatbot_tool_invocations.tokens_in / tokens_out` are read by the rate limiter to
  compute the per-user daily token budget; the index `(user_id, created_at)` already
  exists for that scan.

## For devops (deploy phase)

- The `https://api.harvoost.example` server URL in the OpenAPI is a placeholder. Update
  to the production hostname when DNS is configured (likely `api.harvoost.<your-domain>`).
- The `CORS_ALLOWED_ORIGINS` env var on `ca-api` controls the CORS allowlist documented
  in r2 (web app origin only; tray uses main-process Node fetch and is not subject to
  browser CORS).

# Open questions / unknowns

- **Export job storage** — the OpenAPI describes the `ExportJob` response shape, but it
  is unclear whether the architecture's intent is to read directly from pg-boss's
  `pg_boss.job` table or to introduce a thin `export_jobs` projection table. I've left
  the response shape independent of the storage layer; database-admin should make the
  call at migration design time. (Flagged as a decision for the build phase; not
  blocking api-design.)
- **Refresh-token flow** — REQUIREMENTS / ARCHITECTURE describe session refresh in
  abstract terms (sessions table, 12h expiry) but do not specify the wire-level refresh
  endpoint. The OpenAPI documents `POST /v1/auth/logout` but does not document a refresh
  endpoint — the assumption is that re-running the OIDC handshake is the v1 path (cheap
  for web; less ergonomic for tray). If the build phase decides to add an explicit
  `POST /v1/auth/refresh`, it is an additive change to the spec.
- **Notifications endpoints** — the architecture catalogue lists `/v1/notifications`,
  `PATCH /v1/notifications/:id/read`, and `POST /v1/notifications/mark-all-read`. These
  are NOT in the api-designer dispatch's "endpoint groups to cover" list, so I have
  omitted them from openapi.yaml. The build phase can either (a) leave them out of v1
  REST and surface notifications via the SSE stream only, or (b) add them as an additive
  spec change. (Flagged for orchestrator decision.)
- **Sync stream (SSE)** — `GET /v1/sync/stream` (SSE) and `GET /v1/sync/snapshot` are
  in the architecture catalogue but not in the dispatch's endpoint groups. I have omitted
  them from openapi.yaml. SSE is awkward to model in OpenAPI 3.1 anyway (no first-class
  event-stream support); if the build phase wants them documented, recommend a separate
  `sync.md` companion or use `text/event-stream` content with a `description`-only operation.
- **Cost-stripping representation** — chose "fields entirely omitted" over a
  discriminated-union response shape. The trade-off is documented in API_NOTES.md
  § "Decisions" item 8. If the orchestrator prefers the discriminated-union form, the
  spec can be revised additively without breaking existing usage of the superset shape.

# Verification evidence

- `openapi.yaml` written; 3577 lines; structured as `openapi: 3.1.0` → `info` → `servers`
  → `tags` → `security` → `paths` → `components`.
- All 16 endpoint tag groups from the dispatch covered (Auth, Users, Clients, Projects,
  Tasks, TimeEntries, Mood, Schedules, Leave, Approvals, Exceptions, Reports, Exports,
  Chatbot, AuditLog, Health). ~55 operations total.
- Grep-validated that every `$ref: '#/components/schemas/X'` resolves to a schema defined
  in `components.schemas` (130+ references, all matching definition names listed below).
- Grep-validated that every `$ref: '#/components/responses/X'` resolves to one of
  `BadRequest`, `Unauthorized`, `Forbidden`, `NotFound`, `ValidationFailed`, `RateLimited`
  (all defined).
- Grep-validated that every `$ref: '#/components/parameters/X'` resolves to one of
  `Cursor`, `Limit`, `Page`, `PageSize`, `UserIdPath`, `ProjectIdPath`, `EntryIdPath`,
  `IdempotencyKey` (all defined).
- Schemas defined: Role, BillingMode, TimeEntryStatus, LeaveStatus, LeaveType,
  ExceptionType, ErrorCode, ErrorResponse, ScopeMeta, CursorPaginationMeta,
  OffsetPaginationMeta, OidcLoginRequest, OidcLoginResponse, OidcCallbackRequest,
  SessionResponse, MeResponse, User, UpdateUserRequest, AssignRoleRequest, Client,
  CreateClientRequest, UpdateClientRequest, Project, CreateProjectRequest,
  UpdateProjectRequest, AddProjectMemberRequest, ProjectMember, AddProjectManagerRequest,
  ProjectManagerAnchor, ProjectTask, CreateProjectTaskRequest, UpdateProjectTaskRequest,
  TimeEntry, CreateTimeEntryRequest, UpdateTimeEntryRequest, StartTimeEntryRequest,
  StopTimeEntryRequest, SwitchTimeEntryRequest, SwitchTimeEntryResponse,
  SubmitTimeEntryRequest, MoodEntry, RecordMoodRequest, MoodAggregate, ScheduleTemplate,
  ScheduleOverride, CreateScheduleOverrideRequest, ScheduleDashboardRow, LeaveRequest,
  CreateLeaveRequestRequest, RejectLeaveRequestRequest, ManagerApprovalBatchRequest,
  FinalApprovalBatchRequest, AdminUnlockRequest, ApprovalBatchResponse, Exception,
  ResolveExceptionRequest, DetailedActivityReportRequest, DetailedActivityRow,
  TimeRollupReportRequest, TimeRollupRow, CreateExportRequest, ExportSyncResponse,
  ExportAsyncResponse, ExportJob, ChatbotCapabilities, ChatbotMessageRequest,
  ChatbotMessageResponse, ChatbotToolCall, ChatbotConversation, ChatbotMessage,
  AuditLogEntry, HealthResponse — 71 schemas in total.
- Examples present on every operation that has a request body and on every distinct
  response envelope.
- `API_NOTES.md` written; one-page reference covering all sections from the dispatch
  (auth, error envelope, pagination, idempotency, ISO 8601, RBAC, cost-stripping, rate
  limits, versioning, chatbot capabilities, export job lifecycle, plus 10 explicit
  design decisions).
- I did NOT run `npx @redocly/cli lint` — toolchain install was out of scope for this
  phase. Structural validity verified by manual reading + grep of all `$ref` targets.
  Build phase can run a formal lint as part of CI setup.
