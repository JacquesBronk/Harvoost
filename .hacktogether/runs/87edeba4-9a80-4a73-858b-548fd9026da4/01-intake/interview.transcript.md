# Intake interview transcript — harvoost-timetracking

**Run:** 87edeba4-9a80-4a73-858b-548fd9026da4
**Phase:** 01-intake
**Agent:** product-analyst
**Date:** 2026-05-22

This transcript captures round 1 of the intake interview: the 10 clarifying questions the product analyst raised against the initial PROMPT.md, the user's answers (paraphrased / consolidated from the "Additional clarifications" block appended to PROMPT.md), and the implied scope decisions synthesised from those answers.

---

## Round 1 — Questions & Answers

### Q1. Tenancy & v1 scale
**Question:** Single-tenant or multi-tenant? What user-count target should v1 be sized for?
**Answer:** Single-tenant (one company's data). 50–500 users target.

### Q2. Authentication
**Question:** Which identity provider — Microsoft / Azure AD (Entra ID), Google Workspace, local accounts? Is MFA required at the app layer?
**Answer:** **Microsoft / Azure AD only (Entra ID OIDC SSO).** No local accounts. MFA is inherited from whatever the Azure AD tenant enforces; Harvoost does not add a second factor at the app layer.

### Q3. Tray app targets
**Question:** Which operating systems must the tray app support in v1?
**Answer:** Windows + macOS + Linux. Cross-platform required for v1. Electron is the obvious tech choice.

### Q4. Deployment target
**Question:** Where will this be hosted? Any constraint on cloud / on-prem?
**Answer:** **Azure.** Use Azure-native services — Container Apps or App Service for compute, Azure Database for PostgreSQL, Azure Blob Storage for files, Azure Key Vault for secrets, Application Insights for telemetry. Pairs naturally with Entra ID for SSO.

### Q5. Profitability inputs & billing modes
**Question:** What inputs does the financial dashboard need? Hourly only, or also fixed-fee / non-billable? Are per-employee cost rates required v1, and who can see them?
**Answer:** Projects can mix billing modes per-project — **hourly, fixed-fee, or non-billable** (internal/admin work). Non-billable hours MUST still be tracked and reported (utilisation/admin-load) but don't contribute to revenue. Per-employee cost rates ARE captured in v1, entered by **Admin or Financial Manager only** (sensitive — never visible to Manager or Employee). Margin formula: `revenue − (cost rate × hours)` for hourly; for fixed-fee, `fee − cost-of-hours-burned`. Profitability dashboard must surface both team-level and individual-level margin.

### Q6. Excel export schema
**Question:** What column schema should the Excel export use? Custom, or mirror an existing tool?
**Answer:** **Mirror Harvest's standard CSV/XLSX time-report columns** so existing Harvest-aware workflows keep working. Treat Harvest's detailed time report as the canonical column set (date, client, project, task, notes, hours, billable, billable rate, billable amount, currency, employee, etc.). Provide an XLSX writer that produces this layout from Harvoost data.

### Q7. Manager chatbot
**Question:** What kind of chatbot? Canned-query buttons, NL → tool-call over a fixed query API, or free-form (e.g., text-to-SQL)? What's the trust model?
**Answer:** **LLM-powered NL → permission-scoped query.** The chatbot accepts natural language ("How many hours did Jacques work this week?"), translates intent to a query bounded by the requester's role and visibility scope, and returns the answer. **Critical:** the LLM must NEVER bypass RBAC — results filtered by the same row-level rules that gate the manager dashboard. Treat the LLM as untrusted; do not let it run free-form SQL. Use a **tool-calling pattern** where the LLM picks from a fixed set of parameterised, RBAC-aware query tools. LLM API key (Claude or OpenAI) is a required secret.

### Q8. Autonomous weekly summary
**Question:** Who receives the summary? When is it sent? Where do the motivational quotes come from? What's the failure mode if the LLM is down?
**Answer:** Recipients: **employee and their direct manager.** Cadence: **Monday 08:00 in each recipient's local timezone.** Quote source: a **curated quote list bundled with the app** (no LLM-generated quote, no third-party quotes API; this keeps the autonomous loop deterministic and cost-free). The summary body itself can be LLM-generated from the employee's prior-week timesheet rollup. **Failure mode:** if LLM generation fails, fall back to a deterministic template-rendered summary rather than skipping the email.

### Q9. Timezone handling
**Question:** Is the company single-timezone? If not, how should schedules, summaries, and dashboards handle multiple timezones?
**Answer:** **Per-user local timezone, UTC at rest.** Each user has a `timezone` field on their profile (IANA name, e.g., `Africa/Johannesburg`). All timestamps stored UTC; rendered in the viewer's local timezone. The schedule template (08:00–17:00) is interpreted in the **assigned-employee's local timezone**. Weekly summary cutoff/delivery is per-recipient local Monday 08:00. Shift coverage across timezones is supported via per-user timezones, not per-project overrides (v1).

### Q10. Mood data — visibility & retention
**Question:** Who sees mood data, and at what granularity? Is it identifiable per-employee or only aggregated? What's the retention policy?
**Answer:** Privacy-conscious model. Managers see **only aggregated/anonymised team mood trends** (e.g., team's average mood by day, trendlines), **never named individual mood entries**. Employees can see their own mood history. Admins/FinMgr see org-level aggregates only (same anonymisation rule as managers). **Retention: 90 days raw, after which mood entries are aggregated into weekly bins and the row-level data is deleted.** Document this prominently in the privacy / data-handling section because it directly affects schema design (separate `mood_entries` table with a TTL job).

---

## Implied scope decisions (synthesised from the above)

- **Tech stack direction (architect to confirm):** Azure-friendly and TypeScript-first to share types between web app and Electron tray. Recommended path: Node/TypeScript backend, PostgreSQL, Next.js (or similar React framework) frontend, Electron tray. Final decision is the architect's; this is the heading the prompt points to.
- **Identity:** OIDC against Entra ID. Either map roles via an Entra ID app-role claim or via a post-login role-mapping table inside Harvoost (Admins assign role on user creation / first-login). Architect to choose mechanism.
- **Secrets to be collected at the secrets-intake gate:**
  - Azure tenant ID + client ID + client secret (Entra ID OIDC).
  - Azure Database for PostgreSQL connection string.
  - Azure Blob Storage connection string (for any uploaded files, weekly summary attachments if any).
  - Application Insights instrumentation key / connection string.
  - LLM API key (Claude or OpenAI) — used by the manager chatbot and the weekly summary generator.
  - SMTP / SendGrid credentials for weekly summary email delivery.
- **Bamboo integration is OUT OF SCOPE for v1.** Employees can book leave inside Harvoost; the Bamboo bridge is stubbed for a later phase. The leave booking UI and approval flow must still be fully functional. A `LeaveSyncProvider` interface and the `bamboo_*` schema columns establish the seam.
- **"Conversational interface (chat / voice)" — text chat only in v1.** Voice is deferred to v2.
- **RBAC cascade rule (locked here so the architect can model the data layer):** Manager visibility is the **union** of (a) every user on any project a manager is project-anchored to, and (b) every project any user a manager is person-anchored to is on. Visibility does NOT transit further (no person-of-person, no project-of-project). See REQUIREMENTS.md § RBAC matrix for the worked example.
- **Mood data is structurally separated** from time entries into its own table to make the 90-day TTL job tractable. K-anonymity threshold k≥5 enforced server-side in aggregation queries.
- **The LLM is on the wrong side of the trust boundary** for query construction. Every chatbot tool function takes the requesting user_id as an application-bound argument; the LLM cannot influence which user's scope is applied. Tool list is fixed and finite — no dynamic SQL.

---

## What was deferred for the architect to decide

- Azure region (West Europe vs South Africa North vs other).
- Compute platform within Azure (Container Apps vs App Service vs AKS) — likely Container Apps for v1 simplicity.
- Postgres SKU / HA configuration (drives the SLO discussion).
- Exact list of chatbot tool functions (the analyst defined the shape; the architect defines the registry).
- Whether mood aggregation k-threshold is hard-coded or per-org configurable.
- Final Harvest column schema lock (the analyst noted "Harvest's detailed time report"; the architect should pin to a specific version of that schema).

---

End of round 1 transcript. No further clarification rounds were required; the analyst proceeded to write REQUIREMENTS.md with `[ASSUMED:]` tags on remaining inferences.
