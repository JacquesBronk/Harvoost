# Harvoost — TODO / blocker / readiness inventory

Generated 2026-05-22 by the orchestrator at the close of review attempt 2/2. This is the synthesised picture you need before deciding "deploy infra first" vs "Docker-mock everything locally first".

Source artefacts: REQUIREMENTS.md, ARCHITECTURE.md, every HANDOFF in 04-build/, 05-test/, 06-review/, plus a live grep of `TODO(build-phase-followup)` markers in the codebase (28 hits across 25 files).

---

## Quick-glance triage

| Bucket | Count | What it means |
|---|---|---|
| Deploy-blockers (must fix or accept a no-sign-in deploy) | **2** | F3 (real Entra OIDC), V2 (audit GUC wiring) |
| Demo-blockers (UI won't render data) | **1** | M7 (4 frontend-invented endpoints missing in backend) |
| Security debt (Major) | **3** | M2 LLM leak, M3 token budget, M4 users IDOR |
| Stubbed features (UI/endpoint exists but does nothing meaningful) | **~8** | SSE sync, XLSX writer, OT-WEEK detection, anomaly detection, schedule overrides, real-time overtime job, email retry, several admin pages |
| Code-quality items (non-blocking) | **~9** | start/switch txn race, leave list scope fan-out, HTTP verb divergence, audit-integrity HMAC recompute, etc. |
| Infra TODOs (parallel devops dispatch) | **~6** | Bicep authoring (in flight), Entra App Reg, Key Vault populate, ACS Email region, code signing v1.1, alerts |

---

## A. Deploy-blockers (real prod cutover)

### A1. F3 — Real Entra OIDC JWKS validation NOT wired

- **File:** `apps/api/src/auth/auth.controller.ts:46-87`
- **Status:** TODO comment, deferred by FIX_PLAN concession.
- **Effect in prod:** **Sign-in will not work.** Boot invariants force `MOCK_OIDC=false` in production AND the real Entra branch is unimplemented — `oidcCallback` will throw `OIDCFailureError`. The system fails closed (no auth bypass), but no user can sign in either.
- **Effect in dev:** Works fine via mock OIDC.
- **Fix size:** ~150-300 LOC backend-dev. Needs `jose` library, JWKS fetch from `login.microsoftonline.com/<tenant>/discovery/v2.0/keys`, signature + audience + issuer + nonce + exp verification.
- **Implication for the deploy decision:** If you deploy infra and try to sign in via Entra, you get a 500. You CAN test the API directly with the deprecated inline session token (the build phase kept it for one release), but the cookie-auth + redirect flow won't complete.

### A2. V2 — `AuditService.record()` doesn't `SET LOCAL app.audit_hash_secret` before INSERT

- **File:** `apps/api/src/common/audit/audit.service.ts:30-63`
- **Status:** Surfaced by code-reviewer attempt 2/2 as new critical.
- **Effect in prod:** Once the HMAC migration (`20260522170000_audit_hmac`) is applied, every audit insert raises `insufficient_privilege` (SQLSTATE 42501). The service catches it and logs `error` — the business operation succeeds, but **zero audit_log rows are written.** The 7-year compliance retention contract is unmet.
- **Effect in dev:** If `app.audit_hash_secret` is set per-session, works. If not (current state of dev), same silent-fail behavior.
- **Fix size:** ~15 LOC. Wrap the INSERT in a Prisma `$transaction` that runs `SET LOCAL app.audit_hash_secret = '...'` first (single-quote-escape; the secret is server-side env). Pattern is documented in `04-build/db/HANDOFF.md`.
- **Alternative:** Defer the HMAC migration to v1.0.1 — ship v1 with the original SHA-256 trigger. Less secure (forge-able) but works without the GUC wiring.

---

## B. Demo-blocker (the manager + financial dashboards won't render)

### B1. M7 — Frontend calls 4 endpoints that don't exist on the backend

- **Frontend files:** `apps/web/app/dashboard/page.tsx:63`, `apps/web/app/financial/page.tsx:52-58`, `apps/web/app/dashboard/employees/[userId]/page.tsx:24`, `apps/web/app/dashboard/projects/[projectId]/page.tsx:17`
- **Missing endpoints:**
  - `GET /v1/reports/team-dashboard?date_range=...`
  - `GET /v1/reports/profitability?date_range=...`
  - `GET /v1/reports/employees/:id/rollup`
  - `GET /v1/reports/projects/:id/rollup`
- **Effect:** Pages render `ErrorBlock` with `code: 'NOT_FOUND'` — the most visible demo screens (manager + financial dashboard) are non-functional.
- **Fix size:** ~150 LOC backend-dev. RBAC-scoped GET endpoints that aggregate existing `time_entries` + `employee_cost_rates` + `project_billable_rates`. OR: ~50 LOC frontend remap to call `POST /v1/reports/detailed-activity` + `POST /v1/reports/time-rollup` (already exist).
- **Recommendation:** Add backend endpoints. Cleaner contract. Tests already anticipate them (e2e specs marked NOT-RUN-IN-SANDBOX for these).

---

## C. Security debt (Major; v1.0.1 acceptable)

| # | Where | What | Effect |
|---|---|---|---|
| M2 | `apps/api/src/chatbot/chatbot.controller.ts:119` | `new LLMUnavailableError(err.message)` leaks raw provider error string (may contain user's prompt) to client | Low-frequency PII leak on chatbot failures |
| M3 | `apps/api/src/chatbot/chatbot.controller.ts:62` | Token budget uses `NOW() - INTERVAL '24 hours'` (sliding) instead of local calendar day | Users can burn ~2× the documented budget within 25 hours |
| M4 | `apps/api/src/users/users.controller.ts:35-43` | `GET /v1/users/:id` has no scope check — any employee can iterate | Internal directory leak (email/displayName/timezone harvesting) |

Each is a ~5-15 LOC fix.

---

## D. Stubbed features (UI/endpoint exists but is partial)

These are documented `// TODO(build-phase-followup): ...` comments. The build agents flagged them rather than half-implement.

| Feature | Where | What's missing |
|---|---|---|
| Tray-web SSE sync | `apps/api/src/sync/*` (no controller yet), `apps/tray/main/sync.ts` | The SSE stream that pushes timer-stop/start events from web→tray. Tray currently polls or stays stale. |
| XLSX writer (Excel export) | `apps/api/src/exports/exports.controller.ts:7-32` | Stub returns `{ job_id, status: 'queued' }`. No actual `exceljs` write or Blob upload. |
| Overtime detection — WEEK | `packages/jobs/src/jobs/exception-detection.ts` | Daily/sliding-week is partial; OT_WEEK not flagged. |
| Anomaly detection (2σ) | Same file | Stub. Per REQUIREMENTS F8.3 should compute trailing-4-week stdev. |
| Schedule overrides — broad | `apps/api/src/schedules/schedules.controller.ts` | Admin/FinMgr-wide overrides per F7.3 are stubbed; only updateMine implemented. |
| Real-time overtime worker | `packages/jobs/src/jobs/overtime-realtime.ts` | Stub. Triggered on time-entry close but no work done. |
| Email retry job | `packages/jobs/src/jobs/email-delivery-retry.ts` | Stub for SMTP retry-with-backoff. |
| Admin pages | `apps/web/app/admin/{users,projects,clients,rates}/page.tsx` | Stub-with-TODO. The Admin can't manage users/projects/rates from UI. |
| Final approval page | `apps/web/app/approvals/final/page.tsx` | Stub. FinMgr stage-2 approval must use API directly. |
| Schedule dashboard | `apps/web/app/schedule/page.tsx` | Stub. |

These are *partial* — not strictly broken — but the user-facing impact is "feature listed in spec but nothing happens".

---

## E. Code-quality items (deferrable to v1.0.1)

From code-review attempt 1 (still standing after the fix loop):

- **M1**: `time-entries.controller.ts:132-162` — start/switch implicit-stop + insert outside a transaction → race window (rare; clean 409 vs 500 distinction)
- **M4 (code-rev)**: Mood retention DELETE unconditional vs aggregate-write success → silent data loss for users with no anchor
- **M5 (code-rev)**: Leave list endpoint missing manager-scoped fan-out (employees see only own; managers' approval inbox empty until fixed)
- **M6 (code-rev)**: HTTP method divergence vs OpenAPI (leave-approve uses POST; spec says PATCH; exception-resolve inverse) → 405 from openapi-typed frontend clients
- **m1**: Admin/finmgr short-circuit in RbacScopeService runs 3 queries instead of 1 (hot path)
- **m4**: `admin_email_allowlist` table exists but unused by auth controller
- **m5**: `idempotency_keys` table not in init migration (runtime DDL fallback works but excess CREATE privilege)
- **n1**: Custom ESLint rule for `no-unscoped-prisma-query` is documented-only
- **n2**: `WORKER_MODE=1` boots but doesn't register pg-boss jobs (no scheduled work happens in prod worker container)

Plus from code-rev attempt 2:
- **V1**: `audit-log-integrity.ts` only verifies chain linkage, not HMAC recompute (defence-in-depth gap; BEFORE-INSERT trigger covers the primary surface)

---

## F. What works end-to-end at code surface (NOTHING has been run yet)

| Capability | Surface state |
|---|---|
| Postgres schema + migrations | Init + audit_hmac migrations authored; seed creates Alice/Bob/Carol/Dave fixture |
| Mock OIDC sign-in (dev only) | Works |
| Real OIDC sign-in (prod) | NOT WIRED (A1) |
| Time-entry start/stop/switch with idempotency | Works |
| GIST overlap exclusion | Works (DB trigger) |
| RBAC cascade (union of project-anchored + person-anchored) | Works (RbacScopeService) |
| Two-stage approval (stage1 ≠ stage2 invariant) | Works |
| Mood entry (once-per-day, k≥5 aggregation) | Works |
| Leave booking + approval (with RBAC fix) | Works |
| Exception detection (MISSED_PUNCH + OVERTIME_DAY) | Works |
| Exception detection (OVERTIME_WEEK, ANOMALY) | Stub |
| Schedule template default + own | Works |
| Schedule overrides (project/org broad) | Stub |
| Chatbot (LLM tool-calling, RBAC-scoped, capability gate) | Works (via OpenAI gpt-4o or any provider via Vercel AI SDK; mock OK for tests) |
| Manager dashboard | Broken until M7 endpoints added |
| Financial profitability dashboard | Broken until M7 endpoints added |
| Employee timesheet view | Works |
| Excel export (≤100k rows sync) | Stub |
| Audit log (writes) | Works at code surface; runtime broken in prod by V2 |
| Audit log hash chain (HMAC) | Works (db migration); only useful once V2 fixed |
| Weekly summary scheduler+deliver | Scheduler enqueues to email_delivery_log; deliver path implemented but worker mode doesn't register the job (n2) |
| Helmet + HSTS + CSRF + Throttle | Works |
| HttpOnly cookie + logout POST | Works |
| Electron tray clock-in + mood prompt | Skeleton works; needs SSE for live sync |

---

## G. Path forward — your decision

Your prompt asked: **"deploy infra first to get real Entra/Azure details and hook into dev for testing"** vs **"figure out Docker mocks so we can see application info locally"**.

The two paths aren't mutually exclusive. Here's the honest breakdown:

### Path 1: Deploy infra first, accept partial app

**Pros:**
- You get real Entra Tenant ID + Client ID + Client Secret to wire up. You can then fix A1 (real OIDC) with real test users.
- You can populate Key Vault with real secrets; tests V2 fix against real Azure Postgres.
- Forces the "production-realistic" testing path.

**Cons:**
- The app won't sign in until A1 is fixed. Until then you can hit `/v1/health` and exercise endpoints via curl with the deprecated inline token.
- Manager + Financial dashboards still blank (B1 / M7) until backend endpoints added.
- Costs money — even Burstable dev SKUs are ~$50-100/month for the stack.

**Sequence:**
1. Devops finishes Bicep authoring (~10 min from now).
2. You provision the resources in your Azure subscription (`az deployment group create` from the Bicep).
3. You do the Entra App Registration (manual).
4. You populate Key Vault secrets.
5. Dispatch a focused backend-dev pass: fix A1 (real Entra OIDC), fix A2 (audit GUC), add B1 endpoints.
6. Deploy app images to Container Apps.
7. Sign in, demo the app.

### Path 2: Docker-mock everything locally first

**Pros:**
- Zero Azure cost.
- Faster iteration loop (no deploy cycle).
- You can demo the app TODAY with mock OIDC + Ollama LLM + Azurite + Maildev.
- A1 (real Entra OIDC) can stay deferred — mock OIDC works in dev mode.
- A2 (audit GUC) only matters when HMAC migration is applied; you can run dev with init-only migrations and add HMAC after.

**Cons:**
- Doesn't give you Entra details — you'd be guessing at real auth integration.
- The first prod deploy will still hit A1/A2 cold.
- Manager + Financial dashboards still need B1 fix to show data (Docker doesn't help here).

**Sequence:**
1. `docker compose up -d` (Postgres + Azurite + Maildev + optionally Ollama)
2. `pnpm install` (first time — this hasn't been done yet in this run)
3. `pnpm --filter @harvoost/db prisma migrate dev` (apply init migration only; skip HMAC migration to avoid A2 trap)
4. `pnpm --filter @harvoost/db prisma db seed` (creates Alice/Bob/Carol/Dave)
5. `pnpm dev` (starts apps/api on :3001, apps/web on :3000)
6. Dispatch a focused backend-dev pass for B1 (add the 4 missing reporting endpoints) so the manager dashboard renders.
7. Sign in via the mock OIDC flow as Bob (employee) / Alice (manager) / FinMgr / Admin. Demo each role.
8. Iterate on remaining bugs without Azure spend.
9. When ready for prod, do path-1 sequence — by then A1 (real OIDC) and A2 (audit GUC) and any other gaps can be closed in one focused pass.

### Recommendation

**Path 2 first, then Path 1.** Reasoning:
- Path 2 unblocks demoable progress in ~30 minutes (assuming pnpm install works in your env) at zero Azure cost.
- The "blockers" for prod (A1, A2) are LESS urgent than the visible demo blocker (B1) — Path 2 lets you fix B1 and see the app working before worrying about Azure-specific integration.
- The Bicep IaC will be in place from the devops dispatch, so when you're ready for Path 1 it's literally `az deployment group create` away.
- Path 2 is also useful as a fallback if the Azure provisioning hits a snag (capacity, RBAC, subscription billing alerts).

### What I propose to dispatch next (when devops finishes Bicep)

A focused **backend-dev follow-up** that bundles:
- **B1**: Add the 4 missing reporting endpoints (manager + financial dashboards).
- **A2**: 15-LOC wiring for the audit GUC (so HMAC migration is usable).
- **M2-M4**: 3 quick security cleanups (LLM error leak, token budget local-day, users IDOR).
- **F3 / A1**: Real Entra OIDC JWKS wiring (the largest piece — ~200 LOC).

That gets the app demoably working AND prod-ready in one pass. Then you can decide Path 1 vs Path 2 for actual testing.

---

## H. Predeploy gate caveats (cumulative)

When we reach the predeploy gate, the operator MUST acknowledge:

- [ ] V2 (audit GUC) fixed OR HMAC migration deferred to v1.0.1
- [ ] F3 (real Entra OIDC) wired OR accept that v1 has no sign-in in prod
- [ ] B1 (frontend-invented endpoints) — manager + financial dashboards work OR explicit "demo via curl only" acceptance
- [ ] V1 (audit integrity HMAC recompute) — v1.0.1 acceptable
- [ ] M2/M3/M4 — v1.0.1 acceptable
- [ ] Stubbed features (XLSX, SSE sync, OT_WEEK, anomaly, schedule overrides) — v1.0.1 OR feature flags hide them in UI
- [ ] AUDIT_HASH_SECRET, SESSION_SECRET (≥32 chars, no `dev-` prefix) populated in Key Vault
- [ ] BOOTSTRAP_ADMIN_EMAIL set to a real address
- [ ] MOCK_OIDC unset or false in production env
- [ ] CI smoke test asserts security headers present
- [ ] CVE scan in CI (pnpm audit + Trivy)
- [ ] Application Insights alerts configured for the 6 metrics from architecture (audit integrity, chatbot p95, dashboard p95, 401 spike, 429 spike, error rate > 1%)
- [ ] Code-signing budget approved (~$400/yr) OR ship tray unsigned in v1 (Risk #19)

---

## Open questions for you

1. **Path preference?** Path 2 (Docker first) is recommended; Path 1 (Azure first) is also valid if you want production-realism from day 1.
2. **A1 priority?** Real Entra OIDC is a deploy-blocker. Worth ~200 LOC backend-dev now, or defer?
3. **B1 priority?** Manager + financial dashboards are the most visible demo screens. Recommend fix now.
4. **M2/M3/M4 priority?** Three quick security cleanups (~30 LOC total) — bundle with the next backend-dev pass?
5. **Stubbed feature triage?** XLSX export and SSE sync are the most visible stubs. Worth implementing now, or feature-flag-hide them in UI for v1?
