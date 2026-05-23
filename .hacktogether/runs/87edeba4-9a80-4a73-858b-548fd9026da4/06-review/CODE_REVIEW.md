# Code review — Harvoost

Code reviewer agent for run `87edeba4-9a80-4a73-858b-548fd9026da4` (slug `harvoost-timetracking`). Tier-1 deep review of `RbacScopeService`, `chatbot-tools`, `LLMProvider`, time-entries/approvals/chatbot controllers, idempotency, init migration, jobs. Tier-2/3 sampled.

## Summary

- **Total findings: 18** (blocking: 0, critical: 2, major: 7, minor: 6, nit: 3)
- **Recommendation: FIX_PLAN_NEEDED** — no blockers, but two critical issues (PATCH `/v1/time-entries/:id` body un-validated; leave approve/reject lacks RBAC) should be fixed before deploy. Most issues are tester-confirmed.
- **Spot-check breadth:**
  - Deep read: `RbacScopeService.ts`, `chatbot-tools.ts`, `LLMProvider.ts`, `time-entries.controller.ts`, `approvals.controller.ts`, `chatbot.controller.ts`, `mood.controller.ts`, `reports.controller.ts`, `idempotency.service.ts`, init `migration.sql`, `bearer-auth.guard.ts`, `auth.controller.ts`, `clock.ts`, `weekly-summary-scheduler.ts`, `weekly-summary-deliver.ts`, `mood-retention.ts`, `audit-log-integrity.ts`, `chatbot-prune-old-conversations.ts`, `exception-detection.ts`, `env.ts`, `http-exception.filter.ts`, `roles.guard.ts`.
  - Skim: `leave.controller.ts`, `exceptions.controller.ts`, `schedules.controller.ts`, `exports.controller.ts`, `schema.prisma`, `main.ts`, `llm.module.ts`, `rbac.module.ts`, `api-client.ts`, stubbed jobs.

## Findings

### Blocking
*(none)*

### Critical

**C1.** `apps/api/src/time-entries/time-entries.controller.ts:260-289` — `PATCH /v1/time-entries/:id` accepts an unvalidated raw `Record<string, unknown>` body and pipes each whitelisted key directly into a SQL UPDATE with no type or shape validation. The field allowlist constrains the column names (good — no SQL identifier injection), but the VALUES are arbitrary client-controlled JSON. `start_at`/`end_at` could be sent as `null` (un-NOT-NULL the column? — falls foul of `te_end_at_matches_status` CHECK, throws cryptic 500), `billable` could be a string, `project_id` could be a stringified bigint pointing at a project the user can't see. This is the same finding the tester flagged at Medium (#3); promoting to Critical because it bypasses the existing `RbacScopeService.assertCanSeeProject` check on edit-to-different-project (cross-RBAC privilege through PATCH). **Why it matters:** an employee can repoint a draft entry to a project that's invisible to them, manifest a row that breaks list invariants, and trigger an obscure `te_no_overlap` exclusion violation as a side channel. **Suggested fix:** add an `EditEntrySchema` Zod (subset of `ManualEntrySchema` + partial). If `project_id` is changed, call `rbac.assertCanSeeProject(user.userId, body.project_id)`.

**C2.** `apps/api/src/leave/leave.controller.ts:47-70` — `POST /v1/leave/requests/:id/approve` and `/reject` have **no RBAC check**: any authenticated user can approve or reject any other user's leave request. Comment on line 49 even says `TODO(build-phase-followup): RBAC check that actor is anchored to the requester.` This is a stated invariant (REQUIREMENTS F5.2: "manager approves scoped"; ARCHITECTURE § Leave: "Notifies manager(s)"). **Why it matters:** any logged-in employee can `POST /v1/leave/requests/42/approve` and approve someone else's vacation, then watch the day pass. **Suggested fix:** before the UPDATE, fetch `leave_requests.user_id` and call `await this.rbac.assertCanSeeUser(actor.userId, requesterUserId)`. Also gate with `@Roles('manager','admin','finmgr')`. The e2e test `leave.spec.ts` already asserts `RBAC_FORBIDDEN` for out-of-scope approve — it would fail today on the live stack.

*(Cross-reference: an `AUDIT_HASH_SECRET` env var is defined but never used by the migration's hash chain — see security-reviewer; tester finding #1.)*

### Major

**M1.** `apps/api/src/time-entries/time-entries.controller.ts:132-162` — `start` and `switch` perform their "implicit stop running → insert new running" as two sequential statements outside any transaction. Between the UPDATE and the INSERT, a concurrent retry (or a separate tab) racing on the same user can leave the user with **zero** running entries (both stopped both their entries and neither succeeded to insert because of partial-unique-index `te_one_running_per_user` collision), or — depending on commit ordering — produce a `te_idempotency_unique` violation that surfaces as a 500. **Why it matters:** the idempotency-key dedupe runs OUTSIDE the txn so the second concurrent call doesn't see the cached response yet. **Suggested fix:** wrap the lookup + update + insert + store in `prisma.$transaction(async (tx) => { ... })`; rely on the unique partial index to convert the rare race into a clean 409, and on the idempotency table for retry safety.

**M2.** `apps/api/src/chatbot/chatbot.controller.ts:52-69` — token-budget query window is `NOW() - INTERVAL '24 hours'` (sliding 24h) instead of the requester's local calendar day. A user can burn 50k tokens at 23:59 and another 50k at 00:01 → 100k in two minutes. Tester finding #4 at Medium; I confirm at Major (load-bearing for cost containment). **Suggested fix:** scope the SUM by `created_at >= ((NOW() AT TIME ZONE users.timezone)::date AT TIME ZONE users.timezone)` — or pass in `users.timezone` once and compute the local-day boundary as `localDateFor(now, tz)`.

**M3.** `packages/jobs/src/jobs/weekly-summary-scheduler.ts:48-56` — the scheduler writes a `queued` row to `email_delivery_log` but **never calls `boss.send('summary.deliver_user', ...)`**. The TODO at line 48 is explicit. **In v1 the weekly summary will never deliver** — the `deliver_user` worker is fully implemented but unreached. Tester finding #5 (Medium); promoting to Major because weekly summary is one of the v1 advertised features (F11). **Suggested fix:** add the `await deps.boss.send(...)` call with `{ startAfter: lastMondayUtc.toJSDate() }`. Add `boss: PgBoss` to `JobDeps`.

**M4.** `packages/jobs/src/jobs/mood-retention.ts:55-58` — the raw-row DELETE runs **unconditionally on `created_at < NOW() - INTERVAL '90 days'`**, even if the upstream aggregate INSERTs hit a `mwa_anchor_year_week_unique` conflict and DO NOTHING'd because they were already written, OR if there were no anchored projects/managers for that user (mood data is silently destroyed with no aggregate trail). **Why it matters:** if a user is on zero projects and has no anchored manager, their 90-day-old mood data is just deleted with no aggregate to ever recover stats from. The architecture documents this as "non-recoverable" but the code makes it more aggressive than needed — anchorless users lose mood data entirely with no aggregate trace. **Suggested fix:** restrict the DELETE to rows that contributed to at least one written aggregate, or accept the loss but document it in a `summary_pruned_no_anchor` log line; add an integration test that asserts the loss path for a manager-less, project-less user.

**M5.** `apps/api/src/leave/leave.controller.ts:20-28` + `apps/api/src/exceptions/exceptions.controller.ts:14-37` — leave-list `GET /v1/leave/requests` returns only **own** leave requests (`WHERE user_id = $1::bigint`), which is correct for an employee viewing their own list but **silently omits the manager-scoped view** that the spec requires (a manager seeing leave requests by their reports — REQUIREMENTS F5.2). The controller has no RBAC fan-out using `rbac.getVisibleUserIds`. **Why it matters:** the manager UI `apps/web/app/leave/approvals/page.tsx` will see an empty list. **Suggested fix:** when caller has `manager`/`finmgr`/`admin` role, expand the WHERE to `user_id = ANY(getVisibleUserIds)`; otherwise stay self-only. Pattern is the same as in `time-entries.controller.ts:67-118`.

**M6.** HTTP-method divergence between `openapi.yaml` and controllers (tester finding #11, confirmed Major):
- Spec: `PATCH /v1/leave/requests/:id/approve`; impl: `POST` (`leave.controller.ts:47`).
- Spec: `POST /v1/exceptions/:id/resolve`; impl: `PATCH` (`exceptions.controller.ts:39`).

The frontend's `apiFetch` will issue the spec-shaped verb and get 405. **Suggested fix:** align controller decorators to the spec verbs (PATCH for leave state mutations is the cleaner option). Update `openapi-typescript` codegen to regenerate frontend types.

**M7.** `apps/web/app/dashboard/page.tsx:63`, `apps/web/app/financial/page.tsx:52-58`, `apps/web/app/dashboard/employees/[userId]/page.tsx:24`, `apps/web/app/dashboard/projects/[projectId]/page.tsx:17` — frontend calls `GET /v1/reports/team-dashboard`, `GET /v1/reports/profitability`, `GET /v1/reports/employees/:id/rollup`, `GET /v1/reports/projects/:id/rollup` — **none of these endpoints exist in `openapi.yaml` or in `apps/api`**. The frontend's `apiFetch` will throw an `ApiError` with `code: 'NOT_FOUND'` and the page will render `ErrorBlock`. Tester finding #9; e2e-tester flagged in live-stack outcomes. **Why it matters:** the manager dashboard (F3) and financial dashboard (F4) won't render any data without these endpoints. **Suggested fix:** EITHER add the endpoints to spec + backend (preferred — they're clean GET-with-query-params); OR remap the frontend to `POST /v1/reports/detailed-activity` and `POST /v1/reports/time-rollup`. The build phase deferred this — review must surface it now or it becomes a deploy-day surprise.

### Minor

**m1.** `packages/shared/src/rbac/RbacScopeService.ts:65-75, 121-130` — the admin/finmgr short-circuit issues `SELECT id FROM users WHERE is_active = TRUE` (resp. `projects`) with **no `userId IS NOT NULL` / no soft-delete filter**, but there's no soft-delete column on `users` so this is technically fine. However the function executes **two `canActAsRole` round-trips against `user_roles`** (one for admin, one for finmgr) **and then** runs the SELECT — three queries on every call, every time. **Suggested fix:** combine into one query: `SELECT role FROM user_roles WHERE user_id = $1::bigint AND role IN ('admin','finmgr')`. At 50+ chatbot tool invocations per call (each tool re-queries RBAC), this is the hottest hot path in the codebase.

**m2.** `packages/shared/src/llm/chatbot-tools.ts:79-100` — `listMyProjectsTool` has a `_rbac` parameter prefix but doesn't use RBAC; the query is naturally self-scoped via `WHERE pm.user_id = $1`. The naming is fine, but the JSDoc / inline comment could explicitly say "self-scoped, no RBAC required". **Suggested fix:** add a one-line comment so future readers don't think it's a bug.

**m3.** `apps/api/src/chatbot/chatbot.controller.ts:66-69` — the budget check has a swallow-all `catch` that proceeds without rate-limiting when the DB query throws. The comment says "DB unavailable — proceed but log; never silently block" but **the log is missing** — there's no `this.logger.warn(...)` in the catch arm. Silent fail. **Suggested fix:** add a Nest `Logger` and `logger.warn('chatbot.budget.check_failed', { err })`.

**m4.** `apps/api/src/auth/auth.controller.ts:80-87` — bootstrap-admin assignment is done by an exact case-insensitive match against `BOOTSTRAP_ADMIN_EMAIL`, but the `admin_email_allowlist` table (designed for this exact purpose, in `ARCHITECTURE.md` and the migration) is never consulted on first login. **Suggested fix:** check `admin_email_allowlist` OR `BOOTSTRAP_ADMIN_EMAIL` before assigning `'admin'`. Allows non-bootstrap admins added via UI to be self-provisioned on first OIDC login.

**m5.** `apps/api/src/common/idempotency/idempotency.service.ts:30-40` — `ensureTable()` defensively runs `CREATE TABLE IF NOT EXISTS idempotency_keys` at first use. But this table is **not in `migration.sql`** — only the in-controller defensive DDL exists. If a fresh deploy somehow misses the first request, or if the user role lacks `CREATE TABLE` privilege in prod, the idempotency check fails silently (the `catch { /* ignore */ }`) and the next `INSERT` fails on missing table → 500. **Suggested fix:** add `idempotency_keys` to `prisma/migrations/20260522000000_init/migration.sql` as a first-class table (with `CREATE INDEX` on `(user_id, idempotency_key)` and an expiry/cleanup strategy — the table will grow unbounded). The "5-minute dedupe window" promised in ARCHITECTURE.md § Idempotency requires a cleanup job that doesn't exist.

**m6.** `packages/shared/src/llm/chatbot-tools.ts:269-271` — `findUserByNameTool` returns `{ found: false }` when `rows.length !== 1`, including the case where 2+ users share a name. This leaks "there are at least 2 matching users" via second-order signal (an attacker can compare a known-unique name vs an ambiguous one). Acceptable per the architecture's "uniformly `found:false`" promise, but worth documenting in code. **Suggested fix:** comment that ambiguity is intentionally treated as not-found. Optional: when more than one row matches, RBAC-filter the candidates and return the unique survivor (if exactly one).

### Nit

**n1.** Custom ESLint rule `no-unscoped-prisma-query` is documented in `apps/api/.eslintrc.cjs:5-18` but not implemented. The architecture and tester explicitly call this out; not implementing it is acceptable for v1 but the runtime "RbacGuard warning" fallback mentioned in the comment also doesn't exist (there's no `RbacGuard` — only `RolesGuard` and `BearerAuthGuard`). **Suggested fix:** either implement the rule (small AST walker, ~50 LOC) or remove the misleading comment about the runtime fallback.

**n2.** `apps/api/src/main.ts:7-18` — `WORKER_MODE` branch is a no-op (`setInterval(() => {}, 60_000)`). The container won't crash-loop, but it also won't process any pg-boss jobs. **Suggested fix:** at minimum, log a warning every 60s that the worker is in stub mode. Better: invoke `registerJobs(boss, deps)` from `@harvoost/jobs`. The pg-boss instance isn't wired anywhere in `apps/api` yet — no job will ever fire.

**n3.** `packages/db/prisma/migrations/20260522000000_init/migration.sql:14-16` declares `btree_gist`, `pgcrypto`, `citext`. The schema also needs `pgcrypto`'s `digest()` function for `bearer-auth.guard.ts:56` (used in `encode(digest($1::text, 'sha256'), 'hex')`) — verify the extension is installed under a schema reachable from the app role. Likely fine since `pgcrypto` is in the default `public` schema, but document it.

## Cross-references to security review

Owned by security-reviewer (do not duplicate):
- **Audit hash chain uses SHA-256 with no secret** (`migration.sql:514-554`) — `AUDIT_HASH_SECRET` env var is declared in `env.ts:14` but never consumed by the trigger. Tester finding #1 at High. *security-reviewer leads.*
- **LLM error message leaks server-side detail** (`chatbot.controller.ts:114-116`) — `LLMUnavailableError(err.message)` returns provider error string (potentially containing the user's prompt) to the client. Tester finding #2 at High. *security-reviewer leads.*
- **`MOCK_OIDC` defaults to `true`** (`env.ts:20`) — the guard at `bearer-auth.guard.ts:32` requires `NODE_ENV !== 'production'`, but defaulting the bypass to ON is a hardening miss. Tester finding #6. *security-reviewer leads.*
- **`apps/api` exports session token via non-httpOnly cookie** (per tester E7 + e2e finding) — dual cookie model creates CSRF surface. *security-reviewer leads.*

## Cross-references to test phase

Confirmed findings from TEST_REPORT.md (with re-grades):

| Tester ID | Tester severity | My severity | Notes |
|---|---|---|---|
| #1 SHA-256 audit hash | High | (deferred to sec-rev) | Confirmed; cross-ref to security-reviewer |
| #2 LLM error leak | High | (deferred to sec-rev) | Confirmed; cross-ref to security-reviewer |
| #3 PATCH /time-entries no Zod | Medium | **Critical (C1)** | Re-graded — the project-id un-validated path lets an employee point an entry at an invisible project, escaping RBAC |
| #4 Chatbot 24h sliding window | Medium | **Major (M2)** | Confirmed; cost-containment invariant |
| #5 Weekly scheduler no boss.send | Medium | **Major (M3)** | Re-graded — feature F11 doesn't ship without this |
| #6 MOCK_OIDC default true | Low | (deferred to sec-rev) | Confirmed |
| #7 MISSED_PUNCH 02:00 UTC global | Low | minor (would be m7 if added) | Confirmed; SA-only deploy limits blast radius — acceptable v1 |
| #8 Seed all opt-out | Low | nit | Confirmed; documentation issue only |
| #9 Frontend-invented endpoints | Info | **Major (M7)** | Re-graded — 2 of 4 dashboards (F3, F4) won't render |
| #10 audit_log not populated by mutating controllers | Info | (out of code-review scope) | Confirmed; backend HANDOFF acknowledged |
| #11 HTTP-method divergence | Medium | **Major (M6)** | Confirmed |
| #12 /auth/refresh missing from spec | Low | minor | Confirmed |

New findings beyond TEST_REPORT.md:
- **C2** — Leave approve/reject has no RBAC. The tester's e2e (`leave.spec.ts`) anticipates `RBAC_FORBIDDEN` for out-of-scope but the implementation will simply approve. This was MISSED by the unit/integration tester.
- **M1** — `start`/`switch` race window between implicit-stop and new-insert (transaction missing).
- **M4** — Mood retention DELETE is unconditional vs aggregate write success — silent data loss for anchorless users.
- **M5** — Leave list endpoint only returns own leave; missing the manager-scoped fan-out.
- **m1** — Admin/finmgr short-circuit issues 3 queries instead of 1 (hot path).
- **m4** — `admin_email_allowlist` defined but unused by auth controller.
- **m5** — `idempotency_keys` table not in init migration; no cleanup job.
- **n2** — `WORKER_MODE` boots but never registers any pg-boss jobs.

## Positive notes (brief)

Things the build phase got right that future contributors should preserve:

1. **RBAC tool-curry invariant is correctly upheld.** `chatbot-tools.ts:38-42` curries `requesterId` at factory time; the Zod `parameters` schema for every tool has NO `requesterId` / `user_id` field that the LLM controls. The 13 tool definitions are uniformly self-contained. This is the load-bearing invariant of the chatbot trust model and it's clean.

2. **`safe()` wrapper around tool execution** (`chatbot-tools.ts:22-35`) catches `RbacForbiddenError`/`KAnonymityError` and translates to structured tool-result objects instead of throwing to the LLM — the LLM gets a chance to apologise gracefully without the orchestrator failing. Excellent pattern.

3. **Two-stage approval invariant** in `approvals.controller.ts:82-93` correctly checks the stage-1 actor on **both** approve and reject (line 83 doesn't filter by `action`). This is the subtle bit that the architecture flagged as a likely miss; it's implemented correctly.

4. **GIST overlap pre-check + DB safety net** in `time-entries.controller.ts:233-244` (the manual create path) is exactly the right belt-and-braces pattern: app-level friendly error, DB constraint as ultimate authority. Future contributors should preserve this dual-layer for any new range-based mutations.

5. **Idempotency body-hash check** (`idempotency.service.ts:50-62`) correctly enforces "same key + same body → cached, same key + different body → 409". This was a tester gate; it passes cleanly.

6. **k-anonymity is enforced at the SQL aggregate layer** (`mood-retention.ts:34, 51`) — the `HAVING COUNT(DISTINCT user_id) >= 5` filter prevents under-5 buckets from ever being written, not just queried. The mood retention design's promise of "k≥5 at write time, not query time" is upheld.

7. **Append-only audit log with three layers** (`migration.sql:478-493`): TypeScript model with no update/delete exposed + Postgres trigger + integrity job. Defence in depth is the right answer for an audit trail.

8. **Common error envelope is uniformly applied** via `HttpExceptionFilter` (`http-exception.filter.ts`). Every `DomainError` subclass maps to `{ code, message, details? }` per API_NOTES.md, ZodErrors are surfaced with structured field errors, unhandled errors are scrubbed before reaching the client.

9. **Timezone math is Luxon-based throughout** (`clock.ts`) — `nextWeekdayAt`, `weekRange`, `localDateFor` are pure functions with explicit IANA TZ params. The DST-edges test file covers the gnarly cases.

10. **LLM provider abstraction fails closed** (`LLMProvider.ts:267-283` and `env.ts:54-68`) — the boot-time invariant ("exactly one provider key matches `LLM_PROVIDER`") is enforced TWICE: once at env-load, once at provider factory. The mock provider is the only path that doesn't require a key.

## Quality assessment

| Dimension | Score (1-5) | Notes |
|---|---:|---|
| Correctness | 3 | Two critical defects (C1 PATCH unvalidated + RBAC bypass; C2 leave no RBAC) and one race condition (M1) on a load-bearing path bring this down. Most paths are clean. |
| Testing | 4 | Tester added ~160 tests across 16 files. The author-side unit tests (RBAC, DST, approvals) are excellent. Gaps: leave RBAC unit test missing; PATCH validation missing; no live test execution. |
| Design | 4 | RbacScopeService as single source of truth + chatbot tool-curry pattern + dual-layer error envelope are textbook. LLM provider abstraction is well-bounded. -1 for the missing custom ESLint rule the architecture promised. |
| Consistency | 4 | snake_case at API boundary, camelCase in TS code, all error subclasses extend `DomainError`, all chatbot tools share the same `safe()` wrapper. HTTP-verb divergence vs OpenAPI (M6) and front-end invented endpoints (M7) drop a point. |

---

## Attempt 2/2 verification

Verified on 2026-05-22 by reading the production files cited in FIX_PLAN against the fixes claimed in the build/test handoffs. Sandbox does not permit live execution; verification is by code inspection.

### Status of FIX_PLAN.md items

| # | Finding | Status (this round) | Verified at |
|---|---|---|---|
| 1 | Leave RBAC (approve/reject/cancel) | RESOLVED | `apps/api/src/leave/leave.controller.ts:56-153` — class-level `@Roles('manager','admin','finmgr')` on approve+reject, `loadLeaveOrThrow` + `assertCanActOn` block self-approval and call `rbac.assertCanSeeUser`; audit on all three handlers. |
| 2 | Exception RBAC (self-resolve only) | RESOLVED | `apps/api/src/exceptions/exceptions.controller.ts:41-76` — owner check (`ownerId !== actor.userId → RbacForbiddenError`) before UPDATE; audit on resolve. |
| 3 | MOCK_OIDC default + boot invariants + Entra-aware refusal | RESOLVED (partial-by-design) | `env.ts:24` (`default(false)`), `env.ts:76-86` (prod refuses MOCK_OIDC, default admin email, dev-prefix secrets); `auth.controller.ts:69-82,193-198` (`canUseMockOidc()` requires `!production && !ENTRA_TENANT_ID`); `bearer-auth.guard.ts:38-51`. **Real Entra id_token JWKS validation remains a TODO per the FIX_PLAN concession; boot invariants gate prod, so the surface is closed.** |
| 4 | Throttle decorators applied | RESOLVED | `auth.controller.ts:35` + `chatbot.controller.ts:45`. |
| 5 | PATCH time-entry strict schema + cross-project IDOR | RESOLVED | `time-entries.controller.ts:51-60` (`PatchEntrySchema.strict()`), `:280` (parse), `:299-301` (assertCanSeeProject only when changed), `:323-330` (audit). |
| 6 | Audit HMAC migration (DB side) | RESOLVED on DB side; **integrity job step NOT done** | `packages/db/prisma/migrations/20260522170000_audit_hmac/migration.sql:56-115` — trigger uses HMAC + `current_setting('app.audit_hash_secret')`. **Gap:** `packages/jobs/src/jobs/audit-log-integrity.ts` was NOT updated per FIX_PLAN step 4 — still only verifies linkage. See **V1** below. |
| 7 | Cookie auth (server + client) | RESOLVED | Server: `auth.controller.ts:136-142` (HttpOnly Set-Cookie), `:181` (clearCookie); `bearer-auth.guard.ts:53-63` (cookie fallback); `main.ts:42` (cookie-parser). Client: callback page no `document.cookie` write; `api-client.ts:71,84` (X-Requested-With + credentials:'include'); `AppShell.tsx:103-114` (logout POST). |
| 8 | CSRF middleware | RESOLVED | `csrf.middleware.ts:34-73` — safe-method pass-through; Bearer-exempt; no-cookie pass-through; cookie-bearing requests require Origin in CORS_ALLOWED_ORIGINS OR X-Requested-With. Mounted globally `main.ts:44-48`. |
| 9 | Secret defaults removed + prod refusal | RESOLVED | `env.ts:15-16` (no defaults); `env.ts:83-85` (prod throws on `dev-` prefix). |
| 10 | Helmet + HSTS + Referrer-Policy | RESOLVED | `main.ts:33-39`. |
| 11 | AuditService wired into state-changing handlers | RESOLVED on the code surface; **runtime integration with F6 is broken** | `audit.service.ts:30-63` exists; used in 14 handlers across 7 controllers. `_metadata` folded into `after` JSON. **Critical runtime gap:** AuditService.record() does NOT `SET LOCAL app.audit_hash_secret` before INSERT. See **V2** below. |

### Net findings this round

**New blocking: 0**

**New critical: 2** (V1, V2 — both arise from the F6/F11 integration seam — the individual fixes are correct in isolation but the wiring contract documented by db-admin was not honoured by backend-dev)

---

### V1 (critical, new this round): audit-log-integrity job not updated for HMAC recomputation

**Location:** `packages/jobs/src/jobs/audit-log-integrity.ts:1-54`
**FIX_PLAN reference:** Finding 6, step 4 ("extend audit-log-integrity.ts to also recompute row_hash from canonical JSON + HMAC and assert equality — not just link consistency").
**Description:** The job still loops over rows and only verifies that `row[i].prev_row_hash === row[i-1].row_hash` (link consistency). It does NOT recompute the HMAC. Header comment on line 6 still says SHA-256.
**Why it matters:** F6's threat model assumes the integrity job is the read-side checker. Without HMAC recompute, F6 only defeats append-attacks (already defeated by the no-update/no-delete triggers). The DB BEFORE-INSERT trigger overwrites callers' `row_hash` so the primary surface is partly covered; this is defence-in-depth.
**Suggested fix:** Per db-admin's HANDOFF, run a per-row HMAC recompute in JS using node's crypto and compare. Set the GUC via `$transaction` callback.
**Downstream impact:** Not a deploy-blocker — primary integrity gate is the trigger. Defer to v1.0.1 acceptable.

### V2 (critical, new this round): AuditService.record() doesn't set the HMAC session GUC → audit writes will silently fail in production

**Location:** `apps/api/src/common/audit/audit.service.ts:30-63`
**FIX_PLAN reference:** Finding 6 wiring contract in `04-build/db/HANDOFF.md`.
**Description:** The new HMAC trigger raises `insufficient_privilege` when `app.audit_hash_secret` GUC is unset or `< 32` chars. `AuditService.record()` calls `prisma.$executeRawUnsafe('INSERT INTO audit_log ...')` with no preceding `SET LOCAL app.audit_hash_secret`, and the catch handler swallows the error to `logger.error`. **Result:** every audit write is silently dropped at runtime once the HMAC migration is applied.
**Why it matters:** F11 was promoted to critical specifically for the 7-year compliance promise. With this gap, the production system writes ZERO audit rows.
**Suggested fix:** Update `AuditService.record()` to wrap the INSERT in a `$transaction` callback that first runs `SET LOCAL app.audit_hash_secret = '...'` (with single-quote escaping). ~15 LOC.
**Downstream impact:** Strict deploy-blocker IF the HMAC migration ships in v1. Two paths: (a) wire the GUC in AuditService now, or (b) defer the HMAC migration to v1.0.1 and keep SHA-256 for v1 launch.

### Recommendation

**DEGRADED — proceed with caveats.** 9 of 11 FIX_PLAN items fully resolved. F3 partial by design. V1 and V2 are integration gaps. The auto-loop limit (2/2) is reached. Recommend one more small backend-dev fix-loop OR explicit predeploy-gate tracking.
