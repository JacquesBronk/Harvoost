---
phase: INC-006 SPEC + CONTRACT lane
agent: api-designer
started: 2026-05-24
finished: 2026-05-24
status: complete
---

# Summary
Closed the contract loop for INC-006 (GitHub #7): the `/admin/users` crash caused by
`GET /v1/users` omitting `roles`. I verified the OpenAPI spec already declares `roles`
correctly on the list response, and extended the `@harvoost/contract` response-field
check (the #4 mechanism) to cover `GET /v1/users` so this exact field-level drift now
fails the build going forward (acceptance criterion 4). The real protection gap was in
the contract test, not the spec — the spec was already correct; the bug was a
backend-implementation drift the test did not catch because `GET /v1/users` was not in
the load-bearing set.

# Files touched
- tests/contract/src/contract-spec.ts (modified) — added a `GET /v1/users` entry to `LOAD_BEARING`.
- openapi.yaml (`.hacktogether/runs/87edeba4-.../03-api-design/openapi.yaml`) — NO edit needed; already correct (see below).

# Task 1 — openapi.yaml: NO CHANGE REQUIRED (verified correct)
- `GET /v1/users` (line 299) 200 response uses
  `allOf: [OffsetPaginationMeta, { properties: { data: { type: array, items: { $ref: '#/components/schemas/User' } } } }]`
  (lines 329-336). The list items resolve to the shared `User` schema.
- The `User` schema (line 3111) ALREADY declares
  `roles: { type: array, items: { $ref: '#/components/schemas/Role' } }` (lines 3117-3119)
  and lists `roles` in `required` (line 3127). `[]` when empty is representable (array, no minItems).
- The shared `Role` enum (line 2951) ALREADY has the correct stored values:
  `enum: [admin, finmgr, manager, employee]`. It is `finmgr`, NOT `finance_manager`.
  Grep for `finance_manager` across the whole spec = 0 matches. So there was NO wrong
  shared enum to correct and therefore NO blast radius to flag. I touched neither the
  `Role` enum nor the `User` schema — no risk to `/v1/auth/me` (which also `$ref`s `User`
  via `MeResponse`) or any other consumer.
- Net: the spec was already saying the right thing; the production bug was purely the
  backend list query dropping `roles` (now fixed by the backend lane). I did not make a
  gratuitous edit that would risk reflowing the 3500-line file.

# Task 2 — @harvoost/contract response-field check (the actual fix)
Used the EXISTING mechanism, no new framework. Added one entry to the hardcoded
`LOAD_BEARING` map in `tests/contract/src/contract-spec.ts`:
```
{ key: 'GET /v1/users', envelopeKey: 'data', shape: 'paginated-data',
  reads: ['id','email','display_name','timezone','weekly_summary_opt_out','is_active','roles'] }
```
- `shape: 'paginated-data'` + `envelopeKey: 'data'` matches the spec's
  `OffsetPaginationMeta allOf { data: User[] }` envelope — identical to the existing
  `GET /v1/cost-rates` / `GET /v1/billable-rates` entries, so `resolveRowProps` resolves
  the per-row `User` schema and reads its declared property names.
- `reads` is the full set `apps/web/app/admin/users/page.tsx` consumes off each list row
  (`RolesCell`/`roleSet` -> `user.roles`; plus `id/email/display_name/timezone/is_active`,
  and `weekly_summary_opt_out` from the FE `User` type). `roles` is the load-bearing one.
- I deliberately EXCLUDED `updated_at` from `reads`: the Users list page does not read it,
  and the backend list query (`users.controller.ts:32`) does not SELECT it — so requiring
  it would be wrong. (`updated_at` is still declared on the `User` schema; it's just not a
  list-page read.)

# What downstream agents need to know
- Spec was already conformant for `roles`; the only code change in this lane is the
  contract-test coverage extension. Decision worth logging: "INC-006 spec needed no edit —
  `User`/`Role` already declared `roles`/`finmgr` correctly; the regression was an
  uncaught backend implementation drift, now covered by a new `GET /v1/users` LOAD_BEARING
  contract entry."
- The contract suite resolves the spec from the run folder
  (`.hacktogether/runs/87edeba4-.../03-api-design/openapi.yaml`) via `paths.ts`
  `SPEC_CANDIDATES`. If the spec is ever relocated to `docs/openapi.yaml`, that candidate
  is already in the list.
- Correct-by-construction (I cannot run tests). New entry PASSES against the current spec:
  `User` declares all 7 `reads` fields, so `missing = []`. It would have FAILED against a
  spec/contract that lacked `roles` coverage on this endpoint. Route exists
  (`@Controller('v1/users')` + `@Get()` -> `GET /v1/users`), so the route-existence
  assertion also passes.

# Open questions / unknowns
- None. Scope honored: only `tests/contract/*` changed; `openapi.yaml` verified-only;
  no `apps/*`, no `.github/`.

# Verification evidence
- Grep `finance_manager` in openapi.yaml → 0 matches (shared `Role` enum already correct, no edit/blast radius).
- Read `User` schema (openapi.yaml:3111-3127) → `roles: array<Role>`, in `required`. List items `$ref` `User` (line 335).
- Read `users.controller.ts:22-48` → list query returns `roles` (array_agg, String()-mapped, `[]` default). Matches spec.
- Traced `resolveRowProps(doc, successSchema, 'data', 'paginated-data')` by hand against the spec → returns all 7 `reads` fields → new test PASSES; pre-fix shape would FAIL.
- Orchestrator should run `pnpm --filter @harvoost/contract test` at verify: expect the prior 131 checks GREEN plus the new `GET /v1/users` load-bearing checks (declared+routed, and success-schema declares FE-read fields) GREEN.
