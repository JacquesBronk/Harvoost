---
phase: INC-007 expansion
agent: api-designer
started: 2026-05-24
finished: 2026-05-24
status: complete
---

# Summary
Closed the INC-007 spec loop for the two report rollup drill-in endpoints. The
OpenAPI spec previously declared NO response shape for `GET /v1/reports/employees/{userId}/rollup`
and `GET /v1/reports/projects/{projectId}/rollup` — both lived in the
`@harvoost/contract` test's `KNOWN_SPEC_GAP` (the "ALLOWED_PENDING" list) since
v0.1.0, which is exactly why the FE↔API field drift on them went uncaught and
crashed the drill-in pages. I documented both operations at the final agreed
("pinned") shapes, removed them from `KNOWN_SPEC_GAP`, and promoted both into
the `LOAD_BEARING` response-field map so the contract test now FAILS if the spec
ever drops a rollup field the drill-in pages read.

# Files touched
- .hacktogether/runs/87edeba4-9a80-4a73-858b-548fd9026da4/03-api-design/openapi.yaml (modified)
- tests/contract/src/contract-spec.ts (modified)

## openapi.yaml — what was added
Two new GET operations under the Reports tag, inserted after `/v1/reports/profitability`:
- `GET /v1/reports/employees/{userId}/rollup` (operationId `getEmployeeRollup`) — params
  `$ref UserIdPath` + `$ref DateRange` (required, pattern `YYYY-MM-DD/YYYY-MM-DD`);
  200 → `$ref EmployeeRollup`; errors 400/401/403/404/422; with request/response example.
- `GET /v1/reports/projects/{projectId}/rollup` (operationId `getProjectRollup`) — params
  `$ref ProjectIdPath` + `$ref DateRange`; 200 → `$ref ProjectRollup`; same error set + example.

Two new reusable component schemas (matching the file's existing `*Row` conventions,
reusing the shared `BillingMode` enum):
- `EmployeeRollup` — `user{id,display_name,email,timezone}`, `date_range{from,to}`,
  `hours_by_project[]{project_id,project_name,hours}`, `out_of_scope_project_count`,
  `out_of_scope_hours`, `timeline[]{day,hours}`, `exceptions[]{id,type,local_date,status,details|null}`.
  IDs are strings per the pinned contract.
- `ProjectRollup` — `project{id,name,client_name|null,billing_mode,fixed_fee_amount|null,currency,hours_budget|null}`,
  `date_range{from,to}`, `total_hours`, `billable_hours`, `hours_by_member[]{user_id,display_name,hours}`,
  `hours_by_task[]{task_id|null,task_name,hours}`, `budget` (object, marked nullable/optional via `oneOf [object, null]`).

Also extended the `DateRange` parameter description to mention the two rollup endpoints
(no schema change to it). No other section reflowed; existing 133 checks untouched.

## contract-spec.ts — what changed
- REMOVED both `'GET /v1/reports/projects/{param}/rollup'` and
  `'GET /v1/reports/employees/{param}/rollup'` from `KNOWN_SPEC_GAP` — that array
  is now empty (no remaining FE-consumed endpoint missing a spec entry).
- ADDED both to `LOAD_BEARING` with `shape: 'object'`, `envelopeKey: ''` (the 200
  schema IS the rollup resource — not an `{ items }`/`{ data }` envelope), and the
  top-level `reads` the pages consume:
  - employee: `['user','hours_by_project','out_of_scope_project_count','out_of_scope_hours']`
  - project:  `['project','total_hours','billable_hours','hours_by_member']`

# What downstream agents need to know
- KEY NORMALISATION (load-bearing detail): `loadSpec`, `scan-frontend`, and
  `scan-backend` all collapse every path interpolation to `{param}` (see
  `normaliseSpecPath` / `joinPath`). The `LOAD_BEARING` keys MUST therefore use
  `{param}`, NOT the spec's `{userId}`/`{projectId}`. I used `{param}`; using the
  raw names would make `spec.operations.get(key)` miss and fail the existence
  assertion. The spec file itself keeps the descriptive `{userId}`/`{projectId}`.
- LOAD_BEARING field-checks are TOP-LEVEL only — the `resolveRowProps`/`objectProps`
  helper does not descend into nested objects. The pages read `user.display_name`
  and `project.name`/`project.hours_budget`, but the test asserts the top-level
  `user` / `project` keys exist; the nested sub-fields are documented in the spec
  schemas (and exercised by the response example) but are not individually asserted
  by the contract test (matches how `team-dashboard`'s `hours_by_project` is treated).
- ID TYPING: the pinned shapes use STRING ids (`id`, `project_id`, `user_id`,
  `task_id`) whereas the rest of the spec uses `integer/int64`. I documented exactly
  the pinned (string) shapes — backend-dev emits these, frontend-dev reads these.
  The contract test only checks property NAMES, not types, so this does not affect
  the green/red outcome, but it is an intentional divergence worth recording.
- The `GET /v1/reports/employees/{param}/rollup` and `.../projects/{param}/rollup`
  routes MUST stay registered in `apps/api/src/.../*.controller.ts` (backend lane) —
  the LOAD_BEARING existence assertion now requires both a spec op AND a NestJS route
  (previously KNOWN_SPEC_GAP only required the route). They already exist
  (`@Get('employees/:userId/rollup')`, `@Get('projects/:projectId/rollup')` on the
  `v1/reports` controller); removing either would now fail the contract test.
- Frontend lane: the drill-in pages must send `date_range` (the only declared query
  param on these ops). If they send any other query key, the "query keys are declared
  params" test fails (no KNOWN_PARAM_DRIFT entry was added for these).

## Decision-log candidates (orchestrator may append)
- INC-007 spec: rollup IDs documented as STRING (per pinned contract), diverging from
  the spec's prevailing `integer/int64` convention.
- INC-007 contract: `KNOWN_SPEC_GAP` is now empty; future spec-gap debt must be added
  explicitly rather than inherited.

# Open questions / unknowns
- None. Spec + contract changes are mutually consistent and stay within my lane
  (`openapi.yaml` + `tests/contract/*`); no `apps/*` or `.github/` touched.

# Verification evidence
- Cannot run tests (no Bash). Verified by tracing the contract harness statically:
  - `tests/contract/src/load-spec.ts` keys ops as `${METHOD} ${normaliseSpecPath(rawPath)}`
    → both rollup ops resolve to `GET /v1/reports/{employees|projects}/{param}/rollup`,
    matching the new LOAD_BEARING keys.
  - `resolveSuccessSchema` derefs the 200 `application/json` `$ref` → resolved
    `EmployeeRollup`/`ProjectRollup` object; `resolveRowProps(..., 'object')` returns
    its top-level props, which include every `reads` field → field-check PASSES.
  - Same trace against the OLD spec (no `EmployeeRollup`/`ProjectRollup`, ops absent):
    `successSchema` undefined and op missing → would FAIL → drift can no longer recur.
  - `scan-backend.ts` `joinPath` normalises `:userId`/`:projectId` → `{param}`, so the
    LOAD_BEARING `backend.routeSet` existence check matches the registered routes.
  - Expected contract count delta: −2 KNOWN_SPEC_GAP relaxations, +2 LOAD_BEARING
    endpoints × 2 assertions each (existence+routed, and field-check) = +4 new checks;
    the ~133 pre-existing checks are unchanged.
