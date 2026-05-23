We would like to build a timetracking website (https://www.getharvest.com/)(https://github.com/taiste/harvest-mcp-server) that also has a tray application.

 

 

We want a cascading permission for the roles:

 

Admin - Full access to everything
Financial Manager - Financial dashboard (profitability dashboard) Team member profitability and team profitability, has final approval on all timesheets
Manager - Be able to have a project assigned to them and have a person assigned to them. If a project is assigned to them then all employees that fall under that project are assigned to them. If a person is assigned to them then they can see all the projects they are on.
Employee - be assigned to a project that they will log their time under that specific project.

 

These are important features we would like included:

 

☐  Employee can clock in / clock out - Use the tray application where you ask if someone is ready to start the day and they can click yes or no to start their timer, there is also a 5 star happy face where someone can say their mood. Once someone says yes then their timer starts on the webapp and you can see the timer through out the day in the tray application that you can then stop and start as needed through out the day and stays linked to the webpage.

 

☐  Manager can view team attendance - Managers need to have a dashboard where they can see the projects and all the people under it as well as individuals employees and all the projects linked them. The hours they have worked and what projects they worked those hours under. The managers should only be able to see the projects and individuals that are linked to them.

 

☐  Leave / time-off request flow - link to bamboo (https://docs.bamboopayment.com/mcp) to take the leave that the employee has already logged and submit it into the timesheet for them. We would handle bamboo integration later, for now the employee should just be able to book leave.

 

☐  Approval workflow - managers are the first approvals of the timesheet and the financial manager is the final approval

 

☐  Scheduling or shift assignment - an employee can be assigned to a particular timeslot within a day when they should by default get an 8hr timeslot from 8am-5pm including an hour of lunch. However the manager should be able to change this timeslot if there is a need for a different support time. The admin and financial manager should be able to override shift assignments for a project or all projects or an employee. In the manager dashboard you should be able to see the entire company, team and individuals assigned schedules/shifts.

 

☐  Exception handling (missed punch, overtime, anomaly) - this should be included in the manager dashboard, so that the manager can see over time stats for an employee and projects.

 

☐  Reporting / dashboard - Financial dashboard as mentioned above and the manager dashboard where you can see team and individual information and reporting we want detailed activities and time reports.

 

☐  Export or integration - be able to export the dashboards to an excel document

 

☐  Conversational interface (chat / voice) - chatbot that is linked to the manager dashboard that can return the information as asked. (How many hours did Jacques work this week?)

 

☐  Autonomous agent action without human in the loop - It should automatically generate a summary of what the employee spent their time doing that week with a new motivational quote.

## Additional clarifications (round 1 — 2026-05-22)

The orchestrator surfaced 10 clarifying questions to the user. Answers:

1. **Tenancy & v1 scale** — Single-tenant (one company's data), 50–500 users target.
2. **Authentication** — **Microsoft/Azure AD only** (Entra ID OIDC/SSO). No local accounts. MFA is inherited from whatever Azure AD enforces — Harvoost does not add a second factor at the app layer.
3. **Tray app targets** — Windows + macOS + Linux. Cross-platform required for v1. (Electron is the obvious tech choice.)
4. **Deployment target** — **Azure**. Use Azure-native services (e.g., Container Apps or App Service for compute, Azure Database for PostgreSQL, Azure Blob Storage for files, Azure Key Vault for secrets, Application Insights for telemetry). Pairs naturally with Entra ID for SSO.
5. **Profitability inputs & billing modes** — Projects can mix billing modes per-project: **hourly**, **fixed-fee**, or **non-billable** (internal/admin work). Non-billable hours MUST still be tracked and reported (e.g., as utilisation/admin-load), they just don't contribute to revenue. Per-employee **cost rates** are captured in v1, entered by Admin or Financial Manager only (sensitive — never visible to Manager or Employee). Margin = revenue − (cost rate × hours) for hourly; for fixed-fee projects, margin = (fee − cost-of-hours-burned). Profitability dashboard must surface both team-level and individual-level margin.
6. **Excel export schema** — **Mirror Harvest's standard CSV/XLSX time-report columns** so existing Harvest-aware workflows keep working. Treat Harvest's detailed time report format as the canonical column set (date, client, project, task, notes, hours, billable, billable rate, billable amount, currency, employee, etc.). Provide an XLSX writer that produces this layout from Harvoost data.
7. **Manager chatbot** — **LLM-powered NL → permission-scoped query**. The chatbot accepts natural language ("How many hours did Jacques work this week?"), translates intent to a query bounded by the requester's role and visibility scope, and returns the answer. **Critical:** the LLM must NEVER bypass RBAC — query results must be filtered by the same row-level rules that gate the manager dashboard (manager sees only their assigned people/projects; finmgr/admin see all; employee scope = self). Treat the LLM as untrusted; do not let it run free-form SQL. Use a tool-calling pattern where the LLM picks from a fixed set of parameterised, RBAC-aware query tools. An LLM API key (Claude or OpenAI) will be required as a secret.
8. **Autonomous weekly summary** — Recipients: **employee and their direct manager**. Cadence: **Monday 08:00 in each recipient's local timezone**. Source for motivational quotes: a **curated quote list bundled with the app** (no LLM-generated quote, no third-party quotes API; this keeps the autonomous loop deterministic and cost-free). The summary itself can be LLM-generated from the employee's prior-week timesheet rollup. Failure mode: if LLM generation fails, fall back to a deterministic template-rendered summary rather than skipping the email.
9. **Timezone handling** — **Per-user local timezone, UTC at rest.** Each user has a `timezone` field on their profile (IANA name, e.g., `Africa/Johannesburg`). All timestamps stored UTC; rendered in the viewer's local timezone in the UI. Schedule template (08:00–17:00) is interpreted in the **assigned-employee's local timezone**. Weekly summary cutoff/delivery is per-recipient local Monday 08:00. Shift coverage across timezones is supported via per-user timezones, not per-project overrides (v1).
10. **Mood data** — Privacy-conscious model: managers see **only aggregated/anonymised team mood trends** (e.g., team's average mood by day, trendlines), never named individual mood entries. Employees can see their own mood history. Admins/FinMgr see org-level aggregates only (same anonymisation rule as managers). Retention: **90 days**, after which raw mood entries are aggregated into weekly bins and the row-level data is deleted. Document this prominently in the privacy/data-handling section since it directly affects schema design (separate `mood_entries` table with TTL job).

### Implied scope decisions (from the above)

- Tech stack should be Azure-friendly and TypeScript-first to share types between web app and Electron tray (recommended: Node/TypeScript backend, Postgres, Next.js or similar frontend, Electron tray).
- Identity: OIDC against Entra ID. Use roles claim or post-login role-mapping table inside Harvoost (admins assign role on user creation/first-login).
- Secrets to be collected at the secrets-intake gate: Azure tenant ID + client ID + client secret (for Entra ID OIDC), Azure Database connection string, Azure Blob Storage connection, Application Insights key, LLM API key (Claude or OpenAI) for chatbot + weekly summary, SMTP/SendGrid credentials for weekly summary email delivery.
- Bamboo integration is **out of scope for v1** — employees can book leave in Harvoost; the Bamboo bridge is stubbed for a later phase. The leave booking UI and approval flow must still be fully functional.
- Voice in "conversational interface (chat / voice)" — text chat only in v1; voice deferred to v2.
