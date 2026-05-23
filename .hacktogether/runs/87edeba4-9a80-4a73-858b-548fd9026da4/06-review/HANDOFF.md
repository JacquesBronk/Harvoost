---
phase: review
agent: code-reviewer + security-reviewer (attempts 1 + 2)
started: 2026-05-22T20:27:00Z
finished: 2026-05-22T22:55:00Z
status: complete (2 attempts; DEGRADED verdict; auto-loop limit reached)
---

# Aggregate review summary — final

Two complete review rounds. Initial pass surfaced 11 blocker/critical findings; auto-loop attempt 1/2 dispatched scoped re-build + retest. Attempt 2/2 verified 9/11 fully resolved, 1 partial-by-FIX_PLAN-concession (F3 real Entra OIDC TODO; boot invariants fail-closed), and 2 new criticals from an F6+F11 integration seam (V1 + V2 — both confined to the audit_log path).

## Final verdict

| Reviewer | Verdict | Justification |
|---|---|---|
| code-reviewer | **DEGRADED** | V2 (AuditService missing SET LOCAL app.audit_hash_secret) is a runtime defect that silently drops all audit writes once HMAC migration is applied. Recommends one more 15-LOC backend-dev fix OR predeploy-gate tracking. |
| security-reviewer | **CLEAN at security-primitive layer** | All B1-B4 + C1-C5 resolved at the crypto/access-control layer. Same V2 finding noted as operational (empty audit trail, not exploitable). 7 must-do devops follow-ups documented. |

**Consolidated:** DEGRADED with operational follow-up required before prod cutover. The two new criticals (V1 audit integrity recompute; V2 audit GUC wiring) are NOT security regressions — V1 is defence-in-depth; V2 produces an empty audit trail in prod. The 7-year compliance promise requires V2 fixed before deploy.

## Per-finding final status

| Finding | Status |
|---|---|
| F1 Leave RBAC | RESOLVED |
| F2 Exception RBAC | RESOLVED |
| F3 MOCK_OIDC + boot invariants | RESOLVED (real Entra OIDC validation still a TODO — boot invariants fail-closed; sign-in won't work in prod until JWKS wiring lands) |
| F4 Throttle decorators | RESOLVED |
| F5 PATCH time-entry validation | RESOLVED |
| F6 Audit HMAC migration | RESOLVED at DB layer; integrity job HMAC recompute NOT done (→ V1) |
| F7 HttpOnly cookie (server + client) | RESOLVED |
| F8 CSRF middleware | RESOLVED |
| F9 Secret defaults | RESOLVED |
| F10 Helmet/HSTS | RESOLVED |
| F11 audit_log writes | RESOLVED at code surface; runtime broken without GUC wiring (→ V2) |
| V1 (new) audit integrity HMAC recompute | NOT FIXED (defer to v1.0.1; defence-in-depth) |
| V2 (new) AuditService SET LOCAL wiring | NOT FIXED (must fix before deploy OR defer HMAC migration) |
| Major M2 LLM error leak | NOT FIXED (v1.0.1) |
| Major M3 chatbot token sliding 24h | NOT FIXED (v1.0.1) |
| Major M4 UsersController.getOne IDOR | NOT FIXED (v1.0.1) |

## Auto-loop limit reached

Per playbook, attempt 2/2 is the final review round. Remaining choices:
1. **Out-of-loop fix dispatch** — one more small backend-dev pass for V2 (and optionally V1, M2, M3, M4 cleanup) before predeploy gate.
2. **Accept V2 as predeploy-gate caveat** — proceed to predeploy with documented operational follow-up.
3. **Halt and surface to user** — per playbook for attempt > 2 with remaining critical findings.

## Files

- `06-review/CODE_REVIEW.md` — attempt 1 + appended attempt 2 verification
- `06-review/HANDOFF_code_review.md` — final code-review handoff
- `06-review/SECURITY_REVIEW.md` — attempt 1 + appended attempt 2 verification
- `06-review/HANDOFF_security_review.md` — final security-review handoff
- `06-review/FIX_PLAN.md` — attempt 1 fix scope
- `06-review/HANDOFF.md` — this aggregate

## Predeploy-gate critical caveats (ALL must be addressed at the gate)

1. **V2 (audit GUC wiring)** — fix-before-prod OR defer HMAC migration. 15 LOC of backend-dev work.
2. **F3 real Entra OIDC** — wire JWKS validation before deploy OR accept that v1 has no working sign-in in prod (fails closed via boot invariants).
3. **Devops checklist** (per security-reviewer HANDOFF):
   - Populate AUDIT_HASH_SECRET (≥32 chars) in Azure Key Vault
   - Populate SESSION_SECRET (≥32 chars) in Azure Key Vault
   - Populate BOOTSTRAP_ADMIN_EMAIL with a real address
   - Confirm MOCK_OIDC unset / false in prod
   - CI smoke test for security headers
   - CVE scan in CI (`pnpm audit --prod` + Trivy)
