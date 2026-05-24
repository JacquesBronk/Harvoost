# FEAT-003 (GitHub #16) — Security Review: project task endpoints + admin Tasks UI

**Reviewer:** security-reviewer · **Run:** 87edeba4-9a80-4a73-858b-548fd9026da4 · **Date:** 2026-05-24
**Verdict:** CLEAN — 0 blocking, 0 critical, 0 major; 2 minor, 2 nits. No fix loop.

## Scope
FEAT-003 change set only: `apps/api/src/projects/projects.controller.ts` (createProjectTask, updateProjectTask, schemas, assertProjectVisibleOrThrow, mapTaskNameConflict, mapTaskRow); `apps/web/app/admin/projects/page.tsx`, `apps/web/src/lib/project-tasks.ts`, `apps/web/src/lib/api-types.ts`. Trust-boundary files read (not re-graded): roles.guard, bearer-auth.guard, app.module, zod pipe, http-exception.filter, RbacScopeService, errors/index, audit.service, api-client, clients.controller.

## OWASP coverage
- **A01 Broken Access Control (primary): PASS.** Both routes `@Roles('admin','finmgr')`; guards are global in app.module (BearerAuthGuard then RolesGuard) — unauth→401, employee/manager→403 before handler. `assertProjectVisibleOrThrow` is semantic copy of the `listTasks` gate (non-visible & missing → 404, no 403/500 leak). **Cross-project IDOR closed:** PATCH existence SELECT `WHERE id=$1 AND project_id=$2` *and* the UPDATE WHERE are both project-scoped → a task in project A addressed via project B's path → 404. Audit recorded only on success.
- **A03 Injection: PASS.** All `$queryRawUnsafe` values bound (`$1::bigint`, `$2`, `$3::boolean`); PATCH column names are hardcoded literals, never user input. No `dangerouslySetInnerHTML`/innerHTML in the UI (grep-confirmed); `name` rendered as React-escaped text. No CSV-injection vector introduced *by this change* (see minor-2 for the export boundary).
- **A04/A05 Insecure Design / Misconfig: PASS.** Schemas `.strict()` → mass-assignment blocked; `is_billable`/`is_active` are `z.boolean()` (no truthiness coercion); `is_active` is not creatable (INSERT omits it → DB default TRUE), so no pre-archived/smuggled state. Empty PATCH → 400. Error filter scrubs stack/SQL; 23505 mapped to clean domain error before the unhandled branch.
- **A07 / CSRF: PASS.** Same global BearerAuthGuard (cookie or bearer) as sibling mutating admin routes; shared `apiFetch` sends `credentials:'include'` + `X-Requested-With` (repo CSRF pairing). No new public surface.
- **A09 Logging: PASS.** Audit records actor+ids+{project_id,name,is_billable}; no secrets; AUDIT_HASH_SECRET never logged; no new console/logger calls.
- A02/A06/A08/A10: N/A to this change.

## Findings
- **[minor] CWE-20/704 — non-numeric `project_id`/`task_id` → 500 instead of 404.** An admin/finmgr (unrestricted, skips the `projectIds.includes` short-circuit) sending `/v1/projects/abc/tasks` hits a Postgres 22P02 on the `::bigint` cast → generic scrubbed 500, where AC-5 wants 404. No data leak (envelope scrubbed). **PRE-EXISTING baseline** — `getOne` and `listTasks` use the identical un-guarded cast. Optional fix is controller-wide id-normalization (`/^\d+$/` → 404); doing it only in FEAT-003 would leave siblings inconsistent. Not FEAT-003-specific.
- **[minor] CWE-116 — task `name` not output-encoded for downstream CSV/XLSX export.** A name like `=HYPERLINK(...)` is accepted verbatim (correct — don't restrict input). Inert in the React UI; risk materializes only in the out-of-scope reports/export consumer if it emits cells raw. Neutralize at the **export boundary** (prefix-escape leading `= + - @ \t \r`). Hardening note for the export owner, not a FEAT-003 defect.
- **[nit]** defensive `name.max(200)` stricter than contract (positive — caps unbounded input).
- **[nit]** dedicated `project.task_archive` audit action — good audit hygiene.

## Confirmed NOT vulnerable
Roles-guard bypass (no class-level shadow; method decorators authoritative); 401-before-403 ordering; existence-leak (404 not 403/500); cross-project task IDOR (double-scoped); SQLi (all bound); mass assignment (.strict); stored XSS (React-escaped); error/stack/SQL leak (filter scrubs; 23505 mapped); secret logging (none); CSRF/auth surface (parity with siblings).

**Conclusion:** clean — no fix loop. The two minors are backlog/hardening that match or sit outside the existing repo baseline.
