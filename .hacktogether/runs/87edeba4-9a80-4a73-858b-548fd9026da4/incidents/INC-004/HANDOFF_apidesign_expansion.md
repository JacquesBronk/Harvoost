# INC-004 — API spec expansion (api-designer lane)

Run: `87edeba4-9a80-4a73-858b-548fd9026da4`
Owned file: `.hacktogether/runs/87edeba4-9a80-4a73-858b-548fd9026da4/03-api-design/openapi.yaml`
Status: DONE. Spec edits landed; YAML valid; no allowlist changes required.

## What I added

### 3 operations (all match the FE consumer types in `apps/web/src/lib/api-types.ts`)

1. **`GET /v1/projects/{project_id}/members`** (`operationId: listProjectMembers`, tag `Projects`)
   - Added as a new `get` alongside the existing `post` on the same path.
   - Response: `allOf [OffsetPaginationMeta, { data: ProjectMember[] }]` — i.e. `{ page, page_size, total_count, data }`, matching FE `OffsetPaginated<ProjectMember>`.
   - Query params: `$ref Page`, `$ref PageSize` (reused the existing offset-pagination parameters).
   - Admin-only — documented in the description (`admin` role required; others → 403 `RBAC_FORBIDDEN`).
   - Full request/response example included; standard `401`/`403`/`404` error responses.

2. **`GET /v1/projects/{project_id}/managers`** (`operationId: listProjectManagers`, tag `Projects`)
   - Added as a new `get` alongside the existing `post`.
   - Response: `allOf [OffsetPaginationMeta, { data: ProjectManagerAnchor[] }]`, matching FE `OffsetPaginated<ProjectManagerAnchor>`.
   - Query params `Page`/`PageSize`; Admin-only (description); example + `401`/`403`/`404`.

3. **`DELETE /v1/clients/{client_id}`** (`operationId: deleteClient`, tag `Clients`)
   - The path already declared a `delete`; I rewrote it to document the FK guard. It now documents:
     - success `204` (client deleted),
     - `409 VALIDATION_FAILED` when the client is still referenced by a project (the `projects.client_id` FK is `ON DELETE RESTRICT`; the backend maps the violation to a clean domain error), with an example body + `details: { client_id, referencing_projects }`,
     - plus `401`/`403`/`404`.
   - Admin/FinMgr-only (description).

### 2 reusable component schemas (extended, not inlined)

Both `ProjectMember` and `ProjectManagerAnchor` already existed in `components.schemas` (the existing POST echoes `$ref` them). I extended them with the FE's optional projection fields so the contract test's response-field check passes for the new GETs:

- **`ProjectMember`**: added optional, nullable `user_display_name` and `user_email`. Existing fields (`id`, `project_id`, `user_id`, `joined_at`, `left_at`) unchanged; `required` unchanged (`id, project_id, user_id, joined_at`).
- **`ProjectManagerAnchor`**: added optional, nullable `manager_display_name` and `manager_email`. Existing fields (`id`, `project_id`, `manager_id`, `assigned_at`) unchanged; `required` unchanged.

These optional fields mirror `api-types.ts` (`ProjectMember` ~L249, `ProjectManagerAnchor` ~L259) exactly, so the FE is the source of truth and any field the FE reads is declared in the spec.

## The 2 untouched endpoints (already covered, per dispatch)

- `DELETE /v1/projects/{project_id}/members/{user_id}` — already declared; no change.
- `DELETE /v1/projects/{project_id}/managers/{user_id}` — already declared; no change.

## Contract-test bookkeeping — NO allowlist entries needed

I verified `tests/contract/src/contract-spec.ts`. None of the 5 INC-004 endpoints appear in any allowlist, so nothing had to be removed:
- `KNOWN_SPEC_GAP` = `GET /v1/reports/projects/{param}/rollup`, `GET /v1/reports/employees/{param}/rollup` (report drill-ins; out of scope).
- `KNOWN_ROUTE_GAP` = `POST /v1/time-entries/{param}/submit` (out of scope).
- `KNOWN_PARAM_DRIFT` = `GET /v1/time-entries`, `GET /v1/approvals/queue`, `GET /v1/leave/requests` (out of scope).

`contract-spec.ts` was NOT modified (no obsolete entry existed for these 5). I did not touch `apps/api`, `apps/web`, or `.github/`.

## YAML validity

The spec parses as valid YAML 3.1. I re-checked every scalar that contains a colon-space or quotes (the two prior syntax errors):
- `'Opaque bearer token to send in \`Authorization: Bearer <...>\` ...'` — single-quoted.
- `'e.g. \`{ client: "web", provider: "openai", model: "gpt-4o" }\`.'` — single-quoted.
- `'\`null\` for the currently-open (active) row.'` (x2) — single-quoted.
- My new content: the `deleteClient` description uses a `|` block scalar (so its `any project:` colon is literal, not parsed); the new GET descriptions and the 409 message contain no colon-space sequences; example emails (`bob@harvoost.example.com`) are plain scalars with no colon. No new unquoted-colon hazards introduced.

Every `$ref` I introduced resolves to an existing component (`OffsetPaginationMeta`, `ProjectMember`, `ProjectManagerAnchor`, `Page`, `PageSize`, `ProjectIdPath`, `Unauthorized`, `Forbidden`, `NotFound`, `ErrorResponse`). Every new operation has request/response examples and documented error cases.

## What downstream agents need to know

- The 5 stubbed endpoints are now (a) fully spec-declared and (b) expected to be route-implemented by the parallel `backend-dev` lane. After both lanes land, the contract suite should be FULLY GREEN with no new allowlist entries.
- Decision worth logging: `DELETE /v1/clients/{client_id}` is documented as a **hard delete with an FK guard** (409 when projects still reference the client), reconciling the spec with the FE's delete call and the backend's FK-violation→domain-error mapping. (The pre-existing spec text called it a "soft delete / archive"; I changed the wording to match the implemented behavior. If the backend actually soft-deletes, the 204 description is still accurate and only the summary wording would need a tweak — flag to backend-dev.)
- `ProjectMember`/`ProjectManagerAnchor` now carry optional display-name/email projections; the backend list endpoints should populate them (FE renders them) but they are not `required`, so POST echoes that omit them remain spec-valid.
