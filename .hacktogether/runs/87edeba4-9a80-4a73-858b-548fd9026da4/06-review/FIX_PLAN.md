# Fix plan — review loop attempt 1/2

11 blocker/critical findings from the parallel code + security reviews. The auto-loop dispatches `phases/build.md` with `--scope 06-review/FIX_PLAN.md` to address every item here. Major+ findings deferred to non-blocking section.

## Blocking findings

### Finding 1: Missing authorization on leave approve/reject/cancel
**Source:** security-review (B1) + code-review (C2)
**Severity:** blocking
**Location:** `apps/api/src/leave/leave.controller.ts:47-81`
**Description:** Any authenticated user can approve/reject any pending leave request by ID. `TODO(build-phase-followup)` comment on line 49 acknowledges the gap. The UPDATE is gated only on `status='pending'`.
**Required fix:**
- Before the UPDATE in approve and reject handlers, fetch `leave_requests.user_id`.
- Call `await this.rbac.assertCanSeeUser(actor.userId, leaveRequest.user_id)` — throws `RBAC_FORBIDDEN` 403 if not visible.
- Add `@Roles('manager', 'admin', 'finmgr')` class decorator (or per-handler) — Employees cannot approve.
- Add self-approval guard: `if (String(req.user_id) === actor.userId) throw new ValidationFailedError('Cannot self-approve leave')`.
- Write to `audit_log` (use the AuditService helper added by Finding 11).
**Suggested agent:** backend-dev

### Finding 2: Missing authorization on exceptions/:id/resolve
**Source:** security-review (B2)
**Severity:** blocking
**Location:** `apps/api/src/exceptions/exceptions.controller.ts:39-49`
**Description:** Any user can resolve any exception, hiding overtime/missed-punch/anomaly flags from managers.
**Required fix:**
- Look up `user_id` on the exception.
- Require either `requester.userId === exception.user_id` (self-resolve) OR `requester` is an anchored manager via `RbacScopeService.assertCanSeeUser`.
- Per REQUIREMENTS § F8.1 "Employees can resolve a missed-punch by creating a manual entry" — self-resolve is the safer v1 default.
- Audit log the resolve.
**Suggested agent:** backend-dev

### Finding 3: Mock-OIDC default-on with admin auto-provisioning
**Source:** security-review (B3)
**Severity:** blocking
**Location:** `apps/api/src/config/env.ts:20`, `apps/api/src/auth/bearer-auth.guard.ts:32-41`, `apps/api/src/auth/auth.controller.ts:46-87`
**Description:** `MOCK_OIDC` defaults to `true`. Combined with the predictable `BOOTSTRAP_ADMIN_EMAIL=admin@harvoost.local` default and the unwired real-Entra-validation path, a misconfigured prod deploy is one POST away from full admin takeover.
**Required fix:**
1. Change `MOCK_OIDC` Zod default to `false`.
2. Add boot-time invariant in `loadEnv`: `if (env.NODE_ENV === 'production' && env.MOCK_OIDC === true) throw new Error('Refusing to boot: MOCK_OIDC=1 in production')`.
3. Add redundant invariant in `oidcCallback` and bearer guard: `if (env.NODE_ENV === 'production' || env.ENTRA_TENANT_ID) reject mock-OIDC path with OIDCFailureError`.
4. Implement the real Entra ID id_token validation (signature, audience, issuer, nonce, exp). The TODO at auth.controller.ts is the source.
5. Tighten BOOTSTRAP_ADMIN_EMAIL default: require non-default in production (`if (NODE_ENV === 'production' && BOOTSTRAP_ADMIN_EMAIL === 'admin@harvoost.local') throw`).
**Suggested agent:** backend-dev

### Finding 4: Throttler configured but no @Throttle decorators applied
**Source:** security-review (B4)
**Severity:** blocking
**Location:** `apps/api/src/app.module.ts:35-39` (config) + every controller file (missing decorators)
**Description:** ThrottlerModule declares `chatbot 30/min`, `auth 5/min`, `global 300/min`, but no route opts in via `@Throttle({...})`. The first named limiter (`chatbot 30/min`) becomes the default for every route — `/v1/auth/oidc/callback` is therefore at 30/min, not 5.
**Required fix:**
- Apply `@Throttle({ auth: { ttl: 60_000, limit: 5 } })` on `AuthController` class.
- Apply `@Throttle({ chatbot: { ttl: 60_000, limit: 30 } })` on `ChatbotController.postMessage`.
- Add integration test: hammer `/v1/auth/oidc/callback` 6 times in 60s and assert the 6th returns 429.
**Suggested agent:** backend-dev + tester

## Critical findings

### Finding 5: PATCH /v1/time-entries/:id body un-validated → cross-project IDOR
**Source:** code-review (C1)
**Severity:** critical
**Location:** `apps/api/src/time-entries/time-entries.controller.ts:260-289`
**Description:** Accepts raw `Record<string, unknown>` body, pipes whitelisted columns directly into UPDATE. An employee can submit `project_id: <invisible project id>` and repoint their entry — bypassing project-scope RBAC.
**Required fix:**
- Add `PatchEntrySchema = z.object({ notes: ..., start_at: ..., end_at: ..., project_id: z.string().optional(), task_id: ..., billable: z.boolean().optional() }).strict().partial()` Zod schema.
- Validate the body before the UPDATE.
- If `body.project_id` is present and differs from the current entry's project_id, call `rbac.assertCanSeeProject(user.userId, body.project_id)`.
- Add audit_log entry on the edit (via Finding 11's AuditService).
**Suggested agent:** backend-dev

### Finding 6: Audit log hash chain uses plain SHA-256 (not HMAC)
**Source:** security-review (C1) + tester (#1) + code-review cross-ref
**Severity:** critical
**Location:** `packages/db/prisma/migrations/20260522000000_init/migration.sql:514-558` + `packages/jobs/src/jobs/audit-log-integrity.ts`
**Description:** Trigger computes plain `digest(prev_hash || canonical_json, 'sha256')`. An attacker with DB write access can `DISABLE TRIGGER`, modify rows, recompute the chain — no secret required. `AUDIT_HASH_SECRET` env var is loaded into env.ts:14 but never used. Architecture explicitly promises HMAC.
**Required fix:**
1. **Migration:** add a new migration that DROPS the existing chain trigger and CREATEs a new one using `encode(hmac(prev_row_hash || canonical_json, current_setting('app.audit_hash_secret'), 'sha256'), 'hex')`.
2. **App:** in `apps/api/src/database.module.ts` (or equivalent Prisma init), set the secret per-session via raw query: `await prisma.$executeRawUnsafe('SET LOCAL app.audit_hash_secret = $1', env.AUDIT_HASH_SECRET)` — note: must run on EVERY connection. Easier: use Prisma's `$transaction` callback with `SET LOCAL` at the start.
3. **Backfill:** because existing rows have SHA-256-only hashes, decide between (a) burn-the-chain (start fresh from a genesis row with the new HMAC algorithm) or (b) re-compute hashes for all existing rows using a one-time migration. (a) is safer if the DB hasn't been deployed yet (current case — greenfield). Document the choice.
4. **Integrity job (M5):** extend `audit-log-integrity.ts` to also recompute `row_hash` from canonical JSON + HMAC and assert equality — not just link consistency.
**Suggested agent:** database-admin (migration) + backend-dev (app + job)

### Finding 7: Session token stored in non-HttpOnly cookie (web)
**Source:** security-review (C2)
**Severity:** critical
**Location:** `apps/web/app/auth/callback/page.tsx:50-52`, `apps/web/src/lib/api-client.ts:55-66`, backend `auth.controller.ts:46-87` (issuance side)
**Description:** Auth callback sets `document.cookie = 'harvoost_session=...; samesite=lax'` — no HttpOnly, no Secure. Architecture says HTTP-only cookies issued by `apps/api`; impl deviates.
**Required fix:**
- **Backend:** the OIDC callback handler issues `Set-Cookie: harvoost_session=...; HttpOnly; Secure; SameSite=Lax; Max-Age=...; Path=/` via Nest `Res()` response. Stop returning the raw token in the JSON body.
- **Frontend:** in `apiFetch`, use `credentials: 'include'` and DROP the `document.cookie` reads. Remove the cookie-write from `auth/callback/page.tsx`.
- **Frontend logout** (Finding M9 / E6): POST `/v1/auth/logout` with `credentials: 'include'` before any client-side state clear.
**Suggested agent:** backend-dev + frontend-dev

### Finding 8: No CSRF protection on state-changing endpoints
**Source:** security-review (C3)
**Severity:** critical
**Location:** `apps/api/src/main.ts:20-26`
**Description:** Once C2 lands (HttpOnly cookie + `credentials: 'include'`), cross-site POST attacks become possible. SameSite=Lax blocks some POSTs but not all. No double-submit token / Origin-header check exists.
**Required fix:**
- Option A (preferred): Switch session cookie to `SameSite=Strict`. The tray-app uses bearer-from-keytar so it isn't affected by SameSite.
- Option B: Add CSRF double-submit token middleware. Issue `csrf-token` cookie + require matching `X-CSRF-Token` header on POST/PATCH/DELETE.
- Add Origin-header check middleware on `apps/api`: reject any state-changing request whose `Origin` is not in `CORS_ALLOWED_ORIGINS` (skip for tray which has no browser-Origin).
- Add integration test: cross-origin POST without CSRF token / wrong Origin → 403.
**Suggested agent:** backend-dev

### Finding 9: Default SESSION_SECRET and AUDIT_HASH_SECRET fallbacks
**Source:** security-review (C4)
**Severity:** critical
**Location:** `apps/api/src/config/env.ts:13-14`
**Description:** Zod schema has `.default('dev-session-secret-not-for-prod')` and `.default('dev-audit-secret-not-for-prod')`. Predictable defaults if env vars are missing in prod.
**Required fix:**
- Remove `.default(...)` on both. Make them `z.string().min(32)` (no default).
- Add cross-field invariant in `loadEnv`: `if (NODE_ENV === 'production' && (SESSION_SECRET.startsWith('dev-') || AUDIT_HASH_SECRET.startsWith('dev-'))) throw`.
- For local-dev convenience, supply the dev values via `.env.example` / `secrets.local.md` — not in code.
**Suggested agent:** backend-dev

### Finding 10: No Helmet / HSTS on apps/api
**Source:** security-review (C5)
**Severity:** critical
**Location:** `apps/api/src/main.ts:20-29`
**Description:** No `helmet` middleware. Missing Strict-Transport-Security, X-Content-Type-Options, Referrer-Policy headers.
**Required fix:**
```ts
import helmet from 'helmet';
app.use(helmet({
  contentSecurityPolicy: false,  // API serves JSON
  hsts: { maxAge: 31536000, includeSubDomains: true, preload: false },
  referrerPolicy: { policy: 'no-referrer' },
}));
```
Add to `apps/api/package.json` if not already a dep. Verify HSTS present in CI smoke test.
**Suggested agent:** backend-dev

### Finding 11: State-changing controllers do not write to audit_log
**Source:** security-review (M11, promoted) + tester (#10)
**Severity:** critical (promoted from major — load-bearing for the 7-year compliance promise)
**Location:** `apps/api/src/{users,projects,clients,leave,schedules,approvals,time-entries}/*.controller.ts`
**Description:** Architecture promises 7-year audit log of approvals, rate edits, admin unlocks, role assignments, chatbot tool invocations. Only chatbot tool invocations + time_entry_state_history are wired. Other state-changing endpoints do not write to `audit_log`.
**Required fix:**
- Add `AuditService` (apps/api/src/common/audit/audit.service.ts) with `record(actorId, action, entityType, entityId, before, after, reason?)`. Inserts into `audit_log` table. Use the existing `audit_log` table from the init migration.
- Call `AuditService.record(...)` from EVERY state-changing handler that mutates: users/roles, projects, clients, project_managers/user_managers, project_members, employee_cost_rates, project_billable_rates, leave_requests (approve/reject/cancel), schedule_overrides, time_entries (PATCH and admin unlock), approvals (stage-1 and stage-2).
- Add a unit test asserting the audit row is inserted for at least one representative endpoint per group.
**Suggested agent:** backend-dev

## Scope

**Affected files (auto-loop dispatch focus):**
- `apps/api/src/config/env.ts` — Findings 3, 9
- `apps/api/src/main.ts` — Findings 8, 10
- `apps/api/src/app.module.ts` — Finding 4
- `apps/api/src/auth/{auth.controller.ts,bearer-auth.guard.ts}` — Findings 3, 7
- `apps/api/src/leave/leave.controller.ts` — Finding 1
- `apps/api/src/exceptions/exceptions.controller.ts` — Finding 2
- `apps/api/src/time-entries/time-entries.controller.ts` — Finding 5
- `apps/api/src/common/audit/` (new) — Finding 11
- `apps/api/src/{users,projects,clients,schedules,approvals}/*.controller.ts` — Finding 11
- `apps/api/src/chatbot/chatbot.controller.ts` — Finding 4 (throttle decorator)
- `apps/web/app/auth/callback/page.tsx` — Finding 7
- `apps/web/src/lib/api-client.ts` — Finding 7
- `apps/web/src/components/AppShell.tsx` — Finding 7 (logout POST)
- `packages/db/prisma/migrations/2026XXXX_audit_hmac/migration.sql` (new) — Finding 6
- `packages/jobs/src/jobs/audit-log-integrity.ts` — Finding 6

**Affected tests:**
- New: leave RBAC, exception RBAC, MOCK_OIDC prod-refusal, throttler-applied (429 assertion), PATCH time-entry validation + cross-project IDOR rejection, audit hash chain HMAC verification, audit_log writes per state-changing endpoint, CSRF token check, HSTS header presence.
- Update: existing auth + chatbot tests to align with throttle decorators (they may need `.disableThrottling()` for unit tests).

**New tests required:** YES — at least one integration test per finding (11 new tests). The `tester` agent will pick these up in the post-build test re-run.

## Non-blocking findings (deferred — recorded for follow-up)

These are NOT in the auto-loop scope. They are tracked for post-deploy follow-up unless the predeploy gate decides otherwise.

### Major (from code-reviewer)
- **M1** (code-rev): start/switch implicit-stop + insert outside transaction — race condition. Disposition: ADDRESS in fix loop if time permits; otherwise defer to v1.0.1 hotfix.
- **M2** (code-rev): Chatbot token budget sliding 24h vs local day. Disposition: ADDRESS in fix loop (one-line SQL change).
- **M3** (code-rev): Weekly summary scheduler doesn't enqueue deliver job. Disposition: ADDRESS in fix loop (one-line `boss.send` addition) — feature F11 doesn't ship without it.
- **M4** (code-rev): Mood retention DELETE unconditional vs aggregate write success. Disposition: defer to v1.0.1.
- **M5** (code-rev): Leave list endpoint missing manager-scoped fan-out. Disposition: ADDRESS in fix loop (same `RbacScopeService.getVisibleUserIds` pattern as time-entries).
- **M6** (code-rev): HTTP-method divergence (`POST` vs `PATCH` on leave/exceptions). Disposition: ADDRESS in fix loop (align to openapi.yaml).
- **M7** (code-rev): Frontend-invented endpoints (`team-dashboard`, `profitability`, employee/project rollups) don't exist. Disposition: **Decision needed** — add to backend or remap frontend? Recommended: add to backend (cleaner; 4 new GET endpoints with query params).

### Major (from security-reviewer)
- **M1** (sec): PATCH time-entry validation — overlaps Finding 5 (already in scope).
- **M2** (sec): LLM error leak. Disposition: ADDRESS in fix loop (one-line change).
- **M3** (sec): Chatbot token budget — overlaps code-rev M2 (already in scope).
- **M4** (sec): UsersController.getOne directory leak. Disposition: ADDRESS in fix loop (one RBAC assertion).
- **M5** (sec): Audit integrity job hash recompute — overlaps Finding 6 (already in scope).
- **M6** (sec): Electron `sandbox: false`. Disposition: ADDRESS in fix loop.
- **M7** (sec): Tray protocol handler race. Disposition: defer to v1.0.1.
- **M9** (sec): Frontend logout POST — overlaps Finding 7 (already in scope).
- **M10** (sec): Export RBAC for stub. Disposition: tracked; non-blocking since exports are stubbed.
- **M11** (sec): audit_log writes — overlaps Finding 11 (already in scope).
- **M8** (sec): CORS allowlist boot validation. Disposition: ADDRESS in fix loop (small).

### Minor / nit
All minor and nit findings deferred to v1.0.1 unless the orchestrator chooses to roll up small fixes. The build-phase agents may opportunistically fix nearby nits while touching files for the blocking/critical scope.

## Notes for build-phase fix-loop dispatch

- This is **attempt 1 of 2** of the review loop. If the next review still surfaces blocking/critical findings, attempt 2 is the last chance before HITL escalation.
- The fix scope is dominated by backend-dev work. Database-admin gets one new migration (Finding 6). Frontend-dev gets two small changes (Finding 7 cookie consumption + logout POST).
- Recommended dispatch: scoped `phases/build.md --scope 06-review/FIX_PLAN.md`. Backend-dev does Findings 1–5, 7 (server side), 8, 9, 10, 11. Database-admin does Finding 6. Frontend-dev does Finding 7 (client side).
- After build returns, `phases/test.md` re-runs and the tester adds the 11 new tests (one per finding). Then re-enter `phases/review.md` for attempt 2.
