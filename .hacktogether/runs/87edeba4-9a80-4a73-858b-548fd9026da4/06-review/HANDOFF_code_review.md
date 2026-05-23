---
phase: review (attempt 2/2)
agent: code-reviewer
started: 2026-05-22T21:43:00Z
finished: 2026-05-22T22:10:00Z
status: complete
---

# Summary

Verified the 11 FIX_PLAN items from review attempt 1. 9 are fully resolved; F3 remains a partial-by-design (real Entra id_token validation is a documented TODO, boot invariants gate the prod surface — accepted per the FIX_PLAN concession); F6 and F11 are each correct in isolation but their integration seam is broken — `AuditService.record()` does not set the `app.audit_hash_secret` session GUC that the new HMAC trigger requires, so every audit write will be silently swallowed in production by the AuditService catch handler. The audit-log-integrity job was also not updated to recompute HMAC per FIX_PLAN F6 step 4. Two new critical findings (V1, V2) raised; both are confined to the audit_log path. Verdict: **DEGRADED** — proceed with predeploy caveats. The auto-loop limit (2/2) has been reached.

# Files touched
- 06-review/CODE_REVIEW.md (appended `## Attempt 2/2 verification`)
- 06-review/HANDOFF_code_review.md (overwritten — this file)

# What downstream agents need to know

## For orchestrator
- **Verdict: DEGRADED.** 9/11 FIX_PLAN items RESOLVED, 1 PARTIAL (F3 by design), 2 PARTIAL with integration gaps (F6+F11 via V1+V2). No new RBAC, CSRF, auth, or validation regressions.
- Auto-loop limit (2/2) reached. Recommend ONE more small backend-dev fix-loop OR explicitly accept V2 as a predeploy-gate item.

## For predeploy gate
- **V2 (audit GUC) must be addressed before deploy** OR the HMAC migration must be deferred to v1.0.1.
- **V1 (integrity job HMAC recompute)** can ship as-is for v1; track for v1.0.1.
- **F3 (real Entra OIDC)**: do not flip `NODE_ENV=production` until JWKS validation is wired. Boot invariants will refuse the boot if MOCK_OIDC=true.
- All other fixes (F1, F2, F4, F5, F7-server, F7-client, F8, F9, F10) are clean.

## For security-reviewer
- V2 also affects the security posture (audit-log durability). Coordinate on predeploy-gate caveat.

# Open questions / unknowns
- Whether the orchestrator opts to dispatch a third (out-of-loop) backend-dev fix for V2 or carry it as a predeploy-gate item is an orchestrator call. Fix is small (~15 LOC) and well-specified in db-admin HANDOFF.

# Verification evidence

Files re-read: leave/exceptions/auth/users/projects/approvals/time-entries controllers, env.ts, main.ts, app.module.ts, csrf.middleware.ts, audit.service.ts, audit.module.ts, prisma.service.ts, chatbot.controller.ts, bearer-auth.guard.ts, audit_hmac migration, audit-log-integrity.ts, web app/auth/callback/page.tsx + api-client.ts + AppShell.tsx, throttler.test.ts spot check.

Grep verifications:
- `audit_hash_secret|app\.audit_hash_secret` in `apps/api/src` → **0 matches** (supports V2)
- `AUDIT_HASH_SECRET|SET LOCAL` in `apps/api` → only env schema, no SET LOCAL in production code (supports V2)
- `hmac|audit_hash_secret` in `packages/jobs` → **0 matches** (supports V1)

**Note:** Code-reviewer agent had read-only tools. Orchestrator wrote the artifact files from the agent's inline output.
