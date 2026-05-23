---
phase: intake
agent: product-analyst
started: 2026-05-22T13:15:14Z
finished: 2026-05-22T14:05:00Z
status: complete
---

# Summary
Completed intake for Harvoost — a single-tenant, Azure-hosted, Harvest-style time-tracking SaaS with an Electron tray clock-in flow, RBAC-aware manager dashboards, two-stage approvals, scheduling, Harvest-compatible Excel export, an LLM-driven chatbot constrained to a fixed tool-calling registry, and an autonomous Monday-morning weekly summary email. Round-1 user clarifications resolved tenancy (single, 50–500 users), auth (Entra ID OIDC only, MFA inherited), deployment (Azure native), profitability semantics (mixed billing modes per project, point-in-time cost rates, Admin/FinMgr-only visibility), Excel schema (mirror Harvest), chatbot trust model (LLM + bounded tools, never SQL), weekly-summary cadence (per-recipient local Monday 08:00 with deterministic-template fallback), timezone strategy (per-user IANA, UTC at rest), and mood-data policy (raw 90d retention, manager visibility only via k≥5 aggregates). REQUIREMENTS.md captures 11 feature areas with Given/When/Then acceptance criteria, a full role × feature RBAC matrix with the cascading-visibility rule spelled out with a worked example, a risk register, the Bamboo integration seam designed for v2, and 15 explicit `[ASSUMED:]` tags for items the architect should confirm.

# Files touched
- /mnt/c/Projects/Harvoost/.hacktogether/runs/87edeba4-9a80-4a73-858b-548fd9026da4/01-intake/REQUIREMENTS.md (new)
- /mnt/c/Projects/Harvoost/.hacktogether/runs/87edeba4-9a80-4a73-858b-548fd9026da4/01-intake/interview.transcript.md (new)
- /mnt/c/Projects/Harvoost/.hacktogether/runs/87edeba4-9a80-4a73-858b-548fd9026da4/01-intake/HANDOFF.md (new)

# What downstream agents need to know

## Critical constraints for the architect
- **Deployment target is Azure** (Container Apps or App Service for compute, Azure Database for PostgreSQL, Azure Blob Storage, Azure Key Vault for secrets, Application Insights). Architect picks the specific services and region; user latency points to West Europe or South Africa North.
- **Auth is Entra ID OIDC only.** No local accounts. MFA is inherited from the AD tenant; do not add a second factor at the app layer. Role mapping is either via an Entra app-role claim or via a Harvoost-side `user_roles` table — architect to decide.
- **Electron tray must be cross-platform** (Windows 10/11, macOS 12+, Ubuntu 22.04+). A TypeScript-first stack (Node + Postgres + Next.js + Electron) is the natural fit to share types web ↔ tray.
- **RBAC cascade rule is spelled out unambiguously in REQUIREMENTS.md § RBAC matrix.** The architect must model `project_managers` and `user_managers` as separate join tables and compute manager visibility server-side as the **union** of project-anchored and person-anchored sets (visibility does NOT transit further — see the Alice/Bob/Carol/Dave worked example). Every query function must apply this filter at the data layer; the chatbot uses the same filter — no exceptions.
- **Chatbot trust model:** the LLM is untrusted. Implement a fixed registry of parameterised tool functions; the LLM picks tool + args, but the requesting user_id is bound at the app layer (NOT via LLM prompt) so prompt injection cannot widen scope. The architect must design this tool-calling pattern with explicit RBAC re-application inside every tool.
- **Per-user timezones, UTC at rest.** Every user row has an IANA `timezone`. Schedule templates and weekly summary delivery use the assigned-employee's / recipient's local TZ. Architect must pick a tested TZ library (Luxon, date-fns-tz, etc.) and plan for DST-edge unit tests.
- **Mood data shapes the schema.** Separate `mood_entries` table, daily TTL job that aggregates >90-day rows into weekly bins and deletes raw rows. k≥5 anonymity threshold enforced in aggregation queries (not just UI). Document the residual re-identification risk for small teams.
- **Harvest-compatible Excel export.** Column schema mirrors Harvest's detailed time report (date, client, project, project code, task, notes, hours, hours rounded, billable, invoiced, approved, employee names, billable rate/amount, cost rate/amount, currency, etc.). Cost columns are stripped from the export for non-financial roles server-side.
- **Bamboo integration is OUT OF SCOPE v1, but design the seam now.** `LeaveSyncProvider` interface with NoOp v1 impl; `leave_requests` table includes `bamboo_request_id`, `bamboo_sync_status`, `bamboo_synced_at`. Reference docs: https://docs.bamboopayment.com/mcp.
- **Two-stage approval invariant:** stage-1 approver user_id ≠ stage-2 approver user_id on the same entry, even if one user holds both Manager and FinMgr roles. Architect must enforce this at the workflow service.
- **Audit log is append-only, 7-year retention.** Approvals, cost/billable-rate edits, admin unlocks, role assignments, chatbot tool invocations.

## Operational / NFR notes
- Target SLO is [ASSUMED: 99.5% v1] — drives the architect away from HA-Postgres in v1. Backups to paired region; HA is a v2 follow-up.
- Performance targets per endpoint class are listed in REQUIREMENTS.md § Non-functional. The dashboard p95 < 500ms target assumes appropriate indexes — architect must plan (user_id, date), (project_id, date), and (status) indexes on time_entries at minimum.
- Excel export threshold: ≤100k rows sync, >100k async [ASSUMED] — confirm during architecture once XLSX-writer memory footprint is known.

## Decisions worth surfacing to the run's Decision log
- Bamboo integration explicitly deferred to v2; v1 stores all the data Bamboo will need so the future bridge is purely additive.
- Voice in the conversational interface deferred to v2; v1 is text chat only.
- Weekly summary email is **opt-out** (default on) per [ASSUMED:] — chosen to maximise coverage; user can disable in profile settings.
- A user can hold multiple roles (e.g., Manager + FinMgr), but self-approval across the two approval stages is forbidden.
- Single reporting currency v1 [ASSUMED:] — multi-currency with FX is v2.
- Mood data has a hard 90-day raw retention with non-recoverable aggregation; documented as a privacy commitment.

## Secrets the secrets-intake gate must collect (forwarding to that gate)
- Azure tenant ID + Entra ID app client ID + client secret
- Azure Database for PostgreSQL connection string
- Azure Blob Storage connection string
- Application Insights connection string
- LLM API key (Claude or OpenAI) — chatbot + weekly summary
- SMTP / SendGrid credentials — weekly summary email delivery

# Open questions / unknowns
None blocking — all open items are tagged `[ASSUMED: ...]` in REQUIREMENTS.md with rationale. Notable ones the architect should validate during design (not blocking handoff): availability SLO (99.5%), single-currency assumption, 50k-token/user/day chatbot budget, 100k-row export threshold, 10h daily / 50h weekly overtime defaults, 2σ anomaly threshold, weekly summary opt-out default, Azure region choice.

# Verification evidence
- File present: /mnt/c/Projects/Harvoost/.hacktogether/runs/87edeba4-9a80-4a73-858b-548fd9026da4/01-intake/REQUIREMENTS.md (written via Write tool, no error)
- File present: /mnt/c/Projects/Harvoost/.hacktogether/runs/87edeba4-9a80-4a73-858b-548fd9026da4/01-intake/interview.transcript.md (written via Write tool, no error)
- File present: /mnt/c/Projects/Harvoost/.hacktogether/runs/87edeba4-9a80-4a73-858b-548fd9026da4/01-intake/HANDOFF.md (this file)
- Pre-task investigation confirmed empty /src — no existing code conflicts with the spec; greenfield assumption holds (Glob across repo returned only .claude/ scaffolding and .git/ internals).
