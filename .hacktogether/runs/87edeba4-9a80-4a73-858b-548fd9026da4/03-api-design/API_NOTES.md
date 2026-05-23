# API Notes — Harvoost v1

Companion to `openapi.yaml`. The OpenAPI document is the machine-readable contract; this
file captures the cross-cutting conventions, semantic rules, and architect-level decisions
that backend / frontend / tester agents need before implementing against the spec.

## Authentication

- **IdP**: Microsoft Entra ID, OIDC authorization-code + PKCE.
  - `apps/web` runs the browser handshake.
  - `apps/tray` (Electron) runs an OIDC PKCE flow from the **main process** (system browser
    via the `harvoost://auth/callback` custom scheme); the renderer never sees the token.
- **Session authority**: `apps/api`. Entra ID tokens are exchanged for a **Harvoost session
  token** at `POST /v1/auth/oidc/callback`.
- **Token format**: opaque, server-issued, ~32 bytes base64url. Backed by the `sessions`
  table for revocation. The OpenAPI spec annotates `bearerFormat: JWT` purely for tooling
  compatibility — the token is **not** a JWT.
- **Wire format**: `Authorization: Bearer <session_token>` on every authenticated request.
- **Token lifetime**: 12 hours. Refresh by re-running the OIDC handshake (or via the
  refresh flow when implemented — out of scope for the openapi.yaml in this phase). The
  `sessions.expires_at` column governs server-side TTL; revocation is server-driven via
  `POST /v1/auth/logout`.
- **Exempt endpoints**: only `POST /v1/auth/oidc/login`, `POST /v1/auth/oidc/callback`,
  and `GET /v1/health` are unauthenticated. Everything else carries `security: [{ bearerAuth: [] }]`
  (set globally and inherited).

## Error envelope

Uniform shape on every non-2xx response:

```json
{
  "code": "ENTRY_LOCKED",
  "message": "Cannot edit entry — currently in status manager_approved.",
  "details": { "entry_id": 9001, "status": "manager_approved" }
}
```

Canonical error codes (also enumerated in `components.schemas.ErrorCode`):

| Code | When | Typical HTTP status |
| --- | --- | --- |
| `RBAC_FORBIDDEN` | Authenticated but the requester's RBAC scope does not include the resource. | 403 |
| `ENTRY_LOCKED` | Edit/delete attempted on a time entry whose status is `submitted` / `manager_approved` / `final_approved`. | 409 |
| `CHATBOT_DISABLED` | Active LLM provider/model does not support tool calling. | 503 |
| `IDEMPOTENCY_CONFLICT` | `Idempotency-Key` reused with a different payload. | 409 |
| `VALIDATION_FAILED` | Request body / query params failed schema validation. Also used for business-rule conflicts when no more specific code applies. | 400 / 422 |
| `NOT_FOUND` | Resource does not exist OR is hidden by RBAC (uniform 404 to avoid leaking existence). | 404 |
| `RATE_LIMITED` | Per-min request rate OR per-day token budget exhausted. Headers: `X-RateLimit-*`. | 429 |
| `LLM_UNAVAILABLE` | Provider 5xx / timeout > 15s. | 503 |
| `OIDC_FAILURE` | OIDC state mismatch, expired code, or token validation failure. | 401 |
| `K_ANONYMITY_THRESHOLD` | Mood aggregate has fewer than 5 contributing users; cannot return. | 400 |

The `details` field is **optional** and free-form (object or array). Common shapes:
`{ fields: [{ field, error }] }` for `VALIDATION_FAILED`; `{ resets_at, used, budget }`
for `RATE_LIMITED` on the chatbot.

## Pagination

Two strategies, chosen per resource based on data shape:

### Cursor-based (`cursor`, `limit`)

Used for high-volume, append-mostly, or time-ordered collections where offset pagination
would skip/dupe rows under concurrent inserts:

- `GET /v1/time-entries`
- `GET /v1/exceptions`
- `GET /v1/leave/requests`
- `GET /v1/approvals/queue`
- `GET /v1/audit-log`
- `GET /v1/chatbot/conversations`
- `GET /v1/chatbot/conversations/{id}/messages`
- `POST /v1/reports/detailed-activity`

Query parameters: `cursor` (opaque string) and `limit` (1..200, default 50).
Response includes `next_cursor` (`null` when there is no further page) and `prev_cursor`.

### Offset-based (`page`, `page_size`)

Used for catalog-style collections that are small and rarely change:

- `GET /v1/users`
- `GET /v1/projects`
- `GET /v1/clients`

Query parameters: `page` (>=1, default 1) and `page_size` (1..200, default 50).
Response includes `page`, `page_size`, `total_count`.

## Idempotency

`Idempotency-Key` header is **REQUIRED** on these three operations:

- `POST /v1/time-entries/start`
- `POST /v1/time-entries/stop`
- `POST /v1/time-entries/switch`

Recommended client format: UUIDv7 (sortable, sufficient entropy). The server caches
`(user_id, key) → response` for ~5 minutes. Re-submissions with the same key return the
**original** response (no duplicate row created). Re-submission with the same key but a
**different payload** returns `409 IDEMPOTENCY_CONFLICT` — this is how the server detects
buggy or malicious clients reusing keys.

Server enforcement is the partial unique index `(user_id, idempotency_key) WHERE
idempotency_key IS NOT NULL` on `time_entries`, plus a service-layer cache for the response
body.

## ISO 8601 dates

- Every `date-time` value (request and response) **must** include an explicit offset.
  Acceptable: `2026-05-22T09:30:00+02:00`, `2026-05-22T07:30:00Z`. Rejected: `2026-05-22T09:30:00`.
- Server stores all timestamps in UTC (`TIMESTAMPTZ` columns).
- Clients render in the viewer's local IANA TZ.
- `date` (no time) values are interpreted in the **subject user's** IANA TZ for schedule
  and mood operations — never in the requester's TZ. See `users.timezone`.
- Luxon is the canonical TZ library on the server. Clients are free to use any IANA-aware
  library (`luxon`, `date-fns-tz`, `Temporal`).

## RBAC behavior

- **Scope service**: a single `RbacScopeService.getVisibleUserIds()` and
  `.getVisibleProjectIds()` is the source of truth for visibility on every list endpoint.
- **Scope_meta**: every scoped LIST response includes `scope_meta` with `visible_users`
  and `visible_projects` so clients can render an actionable empty state instead of a
  blank table. Admin/FinMgr callers receive a sentinel `-1` (= unrestricted).
- **Out-of-scope drill-down** returns `403 RBAC_FORBIDDEN`. The API does **not**
  distinguish "doesn't exist" from "exists but hidden" for top-level GET-by-id endpoints
  — both return `404 NOT_FOUND`. The 403 is reserved for cases where the resource is in
  some sense known (e.g., the entry exists and is in a state the requester is not allowed
  to mutate). When in doubt, the 404 form is preferred.
- **Chatbot out-of-scope queries** return **200** with a polite text reply:
  `"I can only answer about people and projects you have access to. {target_name} is not
  in your visible scope."` This is intentional — it preserves the conversational UX and
  avoids leaking the existence of out-of-scope users via 403.
- **Chatbot conversations** use the simpler own-only filter (`user_id = requester_id`)
  rather than the cascade scope. Even FinMgr and Manager cannot read another user's
  conversations via the conversation endpoints. Admin can read for audit only via a
  separate endpoint that is **not exposed in v1**.
- **Two-stage approval invariant**: stage-1-actor ≠ stage-2-actor even if a single user
  holds both Manager and FinMgr roles. The server enforces by reading
  `time_entry_state_history`; violations return `403 RBAC_FORBIDDEN`.

## Cost-column stripping

For Manager and Employee callers, these fields are **omitted server-side** (not just
null-zeroed) from responses on:

- `POST /v1/reports/detailed-activity`
- `POST /v1/reports/time-rollup`
- `POST /v1/exports/excel`
- `GET /v1/time-entries` (and the time-entry returned by start/stop/switch)

Omitted fields:
- `cost_rate`, `cost_amount`
- `billable_rate`, `billable_amount` (for `Manager` and `Employee` on reports/exports —
  these are financial data per the requirements RBAC matrix)
- `margin`, `margin_pct`

The OpenAPI schemas keep these fields nullable so the same type can describe both
authoritative (Admin/FinMgr) and stripped (Manager/Employee) shapes. Client TypeScript
types should reflect this with `| null | undefined` and **never assume presence** without
the requester role. Tests must assert that the fields are entirely absent for non-financial
roles (not merely `null`).

## Rate limiting

Two budgets coexist:

1. **Request-rate cap** (in-process token bucket via `@nestjs/throttler`):
   - `/v1/chatbot/messages`: 30 req/min/user.
   - `/v1/auth/*`: 5 req/min/user.
   - `/v1/exports/excel`: 5 req/min/user.
2. **Daily token budget** (chatbot only):
   - Default 50000 tokens/user/day, configurable in `org_settings.chatbot_daily_token_budget`.
   - Computed by summing `tokens_in + tokens_out` from `chatbot_tool_invocations` for the
     current local-day window.

Responses on chatbot and export endpoints include:

- `X-RateLimit-Limit`: total budget for the current window.
- `X-RateLimit-Remaining`: remaining budget.
- `X-RateLimit-Reset`: UTC epoch-seconds when the budget resets.

`429 RATE_LIMITED` is returned with `details: { budget, used, resets_at }` on the chatbot
when the daily token budget is exhausted.

## Versioning

- **Path-based**: `/v1` prefix on every endpoint.
- **Deprecation policy**: when `/v2` ships, `/v1` remains live for **at least 6 months**.
  Deprecated endpoints set the `Deprecation: true` and `Sunset: <RFC 9745 date>` headers
  for the final 3 months of that window.
- Within a major version, only **additive** changes are allowed: new fields, new endpoints,
  new optional query params. Breaking shape changes go to `/v2`.

## Chatbot capabilities

`GET /v1/chatbot/capabilities` returns the active provider, model, and whether the
chatbot endpoint is enabled. Clients should call this on app load and:

- If `enabled=true`: render the chatbot panel.
- If `enabled=false`: hide the chatbot panel and surface an informational banner showing
  `reason` (e.g. `tool_calling_not_supported_by_provider`).

The `POST /v1/chatbot/messages` endpoint returns `503 CHATBOT_DISABLED` when called while
disabled. The weekly-summary path continues to work in either case because it uses the
provider's `generateText` (no tool calling required).

## Export job lifecycle

`POST /v1/exports/excel` returns one of two response shapes based on the estimated row
count for the filter set:

- **Sync** (row count <= 100000, configurable via `org_settings.export_async_threshold`):
  `200 { mode: "sync", download_url, expires_at, row_count }`. `download_url` is a 24h
  pre-signed Azure Blob Storage URL.
- **Async** (row count > 100000): `202 { mode: "async", job_id, status: "queued", row_estimate }`.
  Clients poll `GET /v1/exports/jobs/{job_id}`. Job status transitions: `queued → running
  → completed | failed`. On `completed`, the response includes `download_url` + `expires_at`.
  The user is also emailed the link.

## Decisions (where the architecture spec was thin)

The architecture spec's "API surface" section was a catalogue, not a contract. The
following choices were made by the api-designer where the architecture was silent or
ambiguous:

1. **Endpoint naming for chatbot conversation messages.** The architecture said
   `GET /v1/chatbot/conversations/:id/messages`. We made the path parameter `{conversation_id}`
   (snake_case in spirit; OpenAPI path-param naming convention) and the cursor pagination
   shape uniform with the other cursor endpoints.
2. **Approval queue endpoint.** The architecture documented `POST /v1/approvals/manager`
   and `POST /v1/approvals/final` for the batch mutators but didn't include a queue-read
   endpoint. Added `GET /v1/approvals/queue` (cursor-paginated) since the UI needs it.
   The queue is RBAC-routed by the requester's role: Manager sees stage-1 (`submitted`);
   FinMgr sees stage-2 (`manager_approved`).
3. **Idempotency-Key payload check.** The architecture mentions key dedup but is silent
   on the "same key, different payload" case. We made this an explicit `409
   IDEMPOTENCY_CONFLICT` so that buggy clients that re-use keys for new operations get a
   clear error instead of a silent no-op.
4. **Time entry submission endpoint.** The architecture spec lists
   `POST /v1/timesheets/submit` with `iso_week` body. We replaced this with the more
   resource-shaped `POST /v1/time-entries/{entry_id}/submit` and a `scope` body field
   (`entry` | `week`), which composes with the rest of the time-entry resource and avoids
   a top-level `/timesheets` resource that doesn't otherwise exist.
5. **Mood endpoint paths.** The architecture used `/v1/mood/today` and `/v1/mood/own`.
   We restructured to `/v1/mood/entries` (collection POST), `/v1/mood/me` (own history),
   `/v1/mood/team/aggregate`, `/v1/mood/org/aggregate` — matching the noun-collection
   convention used elsewhere in the spec.
6. **`POST` reports vs. `GET` reports.** The architecture used `GET /v1/reports/detailed`
   with query parameters. We chose `POST /v1/reports/detailed-activity` (and `time-rollup`)
   so that the filter set — which is large and array-bearing (`project_ids[]`,
   `user_ids[]`) — can be expressed as a JSON body without URL-length limits. Same
   pattern for `POST /v1/exports/excel`.
7. **Health endpoint shape.** Single `GET /v1/health` returns a composite status object
   (`{ status, version, db, redis, llm }`) rather than splitting into `/live` and `/ready`.
   The composite endpoint is the one Azure Container Apps probes; clients use it as well.
   Liveness/readiness can be derived from the composite (status `ok`/`degraded`/`down`).
8. **Cost-column stripping mechanic.** We chose the "fields omitted entirely" approach
   over a discriminated union by role. Rationale: client TS types stay simple
   (`| null | undefined` everywhere), the API never accidentally returns `cost_rate: null`
   when the requester is allowed to see it (a true null), and the omission is asserted
   verbatim by tests. The trade-off is that the OpenAPI schema describes the **superset**
   shape — see the description on each cost field for which role omits it.
9. **Chatbot conversation 404 vs 403.** When a Manager or FinMgr requests a conversation
   owned by another user, the response is `404 NOT_FOUND` (uniform with non-existent ids)
   rather than `403 RBAC_FORBIDDEN`. This prevents leaking the existence of someone else's
   chatbot history. Documented on the operation.
10. **Server entry submission for the existing-entry id form.** A submit by `entry_id`
    with `scope=entry` is the natural single-entry submit. With `scope=week`, the
    `iso_week` field is optional — if absent, the server uses the entry's own ISO week.
    This compositionally covers both the per-entry and per-week submission cases without
    a separate `/timesheets` collection.

## What an implementation must NOT do

- Do not silently strip cost columns "to null". Either omit the field or include the real
  value. Tests assert presence/absence, not nullity.
- Do not use offset pagination for time-entries, exceptions, audit log, or chatbot
  collections. These will paginate incorrectly under concurrent writes.
- Do not parse the `next_cursor` value. It is opaque to clients; the server may change
  its encoding without notice.
- Do not return individual mood entries from `/v1/mood/team/aggregate` or `/v1/mood/org/aggregate`,
  even at k<5. Return the `400 K_ANONYMITY_THRESHOLD` error.
- Do not include the `requester_id` in any chatbot tool argument schema. The orchestrator
  curries it; the LLM must never see it.
- Do not couple the chatbot conversation endpoints to `RbacScopeService`. Use the simpler
  `user_id = requester_id` filter for own-only.
- Do not log full request bodies for `/v1/auth/*`, `/v1/chatbot/messages`, or any endpoint
  that carries free-form user-supplied text. Use redacted logging.
