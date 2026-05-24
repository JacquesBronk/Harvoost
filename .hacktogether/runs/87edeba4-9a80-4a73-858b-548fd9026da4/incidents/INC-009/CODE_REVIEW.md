# CODE_REVIEW.md — INC-009 (GitHub #21)

**Reviewer:** code-reviewer · **Scope:** the two-file additive hotfix diff.
**Verdict: CLEAN — 0 blocking, 0 critical. Ship it.** No fix-loop. (Reviewer is read-only; orchestrator persisted this from returned content.)

## Correctness — confirmed safe (verified vs `schema.prisma`)
- **INNER `JOIN projects p ON p.id = te.project_id` drops no rows:** `TimeEntry.projectId` is non-null `BigInt` with FK `onDelete: Restrict` → every entry has a present project.
- **`LEFT JOIN project_tasks pt`:** `task_id` is nullable → null task yields `task_name = null` (not a dropped row); matches the null-task test and the FE `?? '—'`.
- **No fan-out:** both joins are id-equality to PK rows → cardinality unchanged from the prior id-only SELECT.
- **Alias `te` consistent** in both `list()` and `running()`: all WHERE clauses, ORDER BY, LIMIT, and `$N` param indexes remain valid (the added JOINs introduce no placeholders). `running()` correctly re-aliased + WHERE re-qualified to `te.user_id`/`te.status`.
- **`normalizeRow` untouched & correct** — strips only the 6 cost/rate/margin keys; passes `project_name`/`task_name` through verbatim.
- **Mirrors the precedent** JOIN+projection in `exports.controller.ts:223-225` and `reports.controller.ts:169,176`.

## Security / data-exposure — no widening, no new sensitive exposure
- Scoping stays entirely in the `te.*` WHERE (visibility union); id-equality joins can neither add a row nor surface an unauthorized entry — they only decorate already-authorized rows with the parent name. `running()` is self-only and unchanged.
- Only non-sensitive labels added (`project_name`/`task_name`) — no cost/rate column; `normalizeRow` cost-strip and uniform-404 behavior intact.

## Test quality — meaningful; infra additions legitimate
- Assertions compare against live-resolved seeded values (project 1 name; task "General"); cover running+task, list+task, and the null-task LEFT-join case — non-tautological.
- `ENSURE_IDEMPOTENCY_TABLE` is byte-identical to `IdempotencyService.TABLE_DDL`, confined to the test, and does NOT mask a defect (the table is migration-unowned but self-heals via the service's lazy `CREATE TABLE IF NOT EXISTS` in prod; the test failure was a fresh-DB ordering artifact). The `withSelfScope` stub matches the production return shape and the existing stub convention — `list()` legitimately calls it.

## Non-blocking notes
- minor: could add an explicit "running row not dropped under seeded scope" count assertion (incremental).
- nit: the two beforeAll/afterEach blocks duplicate FEAT-001 setup (matches file style).

## Out-of-scope latent items (noted, NOT blocking; pre-existing)
- `openapi.yaml` `TimeEntry` doesn't declare `project_name`/`task_name` (FE reads them) — invisible to the contract suite; optional follow-on.
- 2 pre-existing `/v1/health` e2e fails (Reflector wiring in full-AppModule harness) — proven present at HEAD; not a regression.
- `idempotency_keys` owned by no migration (app-lazily-created) — benign in prod; optional db-lane hardening.
- `hours` column still omitted from the list SELECT (Hours renders `—`) — deliberately out of INC-009 scope; track separately.
- DECISION agreed: skipping start()/switch() RETURNING enrichment correctly closes #21 (FE re-fetches the list).

## Quality: Correctness 5 · Testing 5 · Design 5 · Consistency 5. Auto-loop: none.
