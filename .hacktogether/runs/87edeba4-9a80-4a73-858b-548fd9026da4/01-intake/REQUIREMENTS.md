# Requirements — harvoost-timetracking

## Analysis

Harvoost is a single-tenant, Azure-hosted, Harvest-style time-tracking SaaS for one company (50–500 users). The product surface is a web app (manager/finmgr/admin dashboards, employee timesheets, leave booking) plus a cross-platform Electron tray app (employee clock in/out with mood capture). The codebase today is empty apart from the HackTogether scaffolding — nothing is built yet, so every story below is greenfield.

Round-1 clarifications have already locked the major shape decisions: Entra ID OIDC for auth, Azure-native infra, per-user IANA timezones with UTC at rest, LLM-driven manager chatbot constrained to a fixed tool-calling surface (no free-form SQL), per-user mood data with a 90-day raw-retention rule and manager-only-aggregated visibility, weekly summary emails on Monday 08:00 local with a deterministic-template fallback, Harvest-compatible Excel export, and Bamboo integration deferred to v2 (with the leave-booking flow nonetheless fully functional in v1). What this spec adds is: testable acceptance criteria per feature, a definitive RBAC matrix (the cascading visibility rule is stated explicitly and unambiguously), edge-case handling for clock-in/sync/timezone seams, and a risk register the architect needs before drawing infra.

The most likely misunderstandings by an implementor — flagged here so the architect and builders catch them early — are: (1) the cascading manager visibility is **transitive across the project↔person edge** (manager on project P sees everyone on P; manager assigned to person X sees every project X is on; combined, the manager's view is the union — see RBAC section below for the exact rule); (2) the LLM must not be on the trust boundary for query construction (tool-calling only); (3) the schedule template (08:00–17:00, 1hr lunch) is interpreted in the **employee's** local timezone, not the manager's or the server's; (4) mood data has both a visibility rule (k-anonymity threshold) and a retention rule (90 days raw, then aggregate), both of which shape the schema.

## Project overview & business goal

**Product:** Harvoost — internal time tracking + profitability tooling for a single company, modelled on getharvest.com plus a few opinionated additions (tray-app clock-in with mood capture, RBAC-aware chatbot, autonomous weekly summary).

**Business goal:** Replace ad-hoc time tracking with a single source of truth that (a) makes it frictionless for employees to log time accurately, (b) gives managers real-time visibility into their team's activity and exceptions, (c) gives finance accurate margin data per project and per employee, and (d) reduces the manual reporting burden via Excel export and weekly auto-summaries.

**Non-goals:** Harvoost is not a payroll system, not an HRIS (BambooHR remains the system of record for leave balances — Harvoost only captures the *request*), and not a billing/invoicing tool (it exposes margin and exportable line items; invoicing is downstream).

**Scale target (v1):** 50–500 named users in a single tenant. Single region (Azure region TBD at architecture phase, [ASSUMED: West Europe or South Africa North — defer to architect]).

## Personas

### Admin (org-administrative role)
- Provisions users, assigns initial roles, configures cost rates and billable rates, can override anything (schedules, approvals, rates).
- Sees all data. Manages clients and projects. Holds the keys to sensitive financial data.
- Typical user: ops/IT lead or COO.

### Financial Manager (FinMgr)
- Final approver on timesheets (stage 2 of the approval flow).
- Owns the profitability dashboard: project margins, team margins, individual margins, utilisation.
- Sees and can edit per-employee cost rates and per-project/per-task billable rates.
- Cannot provision users or change roles (that is Admin-only).
- Typical user: finance director, CFO, FP&A lead.

### Manager
- First approver on timesheets for their assigned scope (stage 1 of the approval flow).
- Has projects assigned to them and/or people assigned to them. See RBAC matrix for the precise cascade.
- Can override schedules for their assigned scope.
- Sees aggregated team mood; never sees individual named mood entries.
- Cannot see cost rates or margins (financial data is gated to Admin + FinMgr).
- Typical user: team lead, engineering manager, project manager.

### Employee
- Logs their own time via tray and/or web. Books leave. Sees their own timesheet, their own mood history, their own schedule, their own weekly summary.
- Submits timesheet for approval; cannot self-approve.
- Cannot see any other employee's time, mood, or rate.

## RBAC matrix

### Cascading manager visibility — the canonical rule

> A Manager M's visibility set is the **union** of two queries, computed at request time:
> 1. **Project-anchored:** for every project P where M is in `project_managers(project_id=P, user_id=M)`, M sees every user U currently assigned to P (via `project_members`), and M sees all time entries logged against P by any U.
> 2. **Person-anchored:** for every user U where M is in `user_managers(user_id=U, manager_id=M)`, M sees every project P that U is currently assigned to, and M sees all of U's time entries on those projects.
>
> The union of these two sets is M's full visibility scope. **Visibility does not transit further** — i.e., if M is anchored to person Bob, M sees Bob's projects and Bob's time on them, but does NOT see *other employees on those same projects* unless those employees are themselves either anchored to M or members of a project M is anchored to.

**Worked example.** Suppose:
- Manager Alice is project-anchored to project `P1`. Bob and Carol are on `P1`. Bob is also on `P2`. Dave is on `P2` (not on `P1`). Alice has no person-anchor.
- Alice's visibility:
  - From P1: sees Bob and Carol; sees their time on P1.
  - Does NOT see Bob's time on P2 (because Alice is anchored to P1, not to Bob).
  - Does NOT see Dave at all.
- Now add: Alice is also person-anchored to Bob.
  - Alice's visibility expands: she now also sees Bob's time on P2, and she sees P2 as a project Bob is on.
  - She still does NOT see Dave (Dave is on P2 only because of his own membership; he's not anchored to Alice and P2 is not anchored to Alice).

This rule applies uniformly to: manager dashboard queries, timesheet approval queue, schedule overrides, exception reports, **and chatbot tool-call results**. The chatbot does not get a wider lens than the dashboard.

### Role × feature matrix

Legend: `R` = read, `W` = write / create / edit, `A` = approve (workflow action), `—` = no access. "Scoped" means the role only sees their RBAC-scoped slice (e.g., own data for Employee, anchored set for Manager).

| Feature                                           | Admin | FinMgr        | Manager           | Employee     |
|---------------------------------------------------|:-----:|:-------------:|:-----------------:|:------------:|
| Own time entries (clock in/out, edit, delete)     | R/W   | R/W           | R/W               | R/W (own)    |
| Own mood entries                                  | R/W   | R/W           | R/W               | R/W (own)    |
| Other users' time entries                         | R/W   | R             | R (scoped)        | —            |
| Other users' raw mood entries                     | —     | —             | —                 | —            |
| Aggregated/anonymised team mood (k≥5)             | R     | R             | R (scoped)        | —            |
| Org-wide aggregated mood                          | R     | R             | —                 | —            |
| Own timesheet submission                          | —     | —             | —                 | W            |
| Timesheet approval — stage 1 (manager approve)    | A     | —             | A (scoped)        | —            |
| Timesheet approval — stage 2 (final approve)      | A     | A             | —                 | —            |
| Leave request (create)                            | W     | W             | W                 | W (own)      |
| Leave request approval                            | A     | —             | A (scoped)        | —            |
| Schedule — own                                    | R/W   | R/W           | R/W               | R (own)      |
| Schedule — override within scope                  | W     | W (any)       | W (scoped)        | —            |
| Schedule — project-wide / employee-wide override  | W     | W             | —                 | —            |
| Schedule dashboard (company / team / individual)  | R all | R all         | R (scoped)        | R (own)      |
| Projects — create / edit / archive                | W     | W (rates only)| —                 | —            |
| Project members — assign / remove                 | W     | —             | —                 | —            |
| Clients — create / edit                           | W     | W             | —                 | —            |
| Tasks (project sub-categories) — create / edit    | W     | W             | R (scoped)        | R (scoped)   |
| Per-employee cost rates                           | R/W   | R/W           | —                 | —            |
| Per-project / per-task billable rates             | R/W   | R/W           | —                 | —            |
| Financial / profitability dashboard               | R     | R             | —                 | —            |
| Manager dashboard (team + individual rollups)     | R all | R all         | R (scoped)        | —            |
| Exception list (missed punch / overtime / anomaly)| R all | R all         | R (scoped)        | R (own)      |
| Reports — detailed activity & time                | R all | R all         | R (scoped)        | R (own)      |
| Excel export                                      | W all | W all         | W (scoped)        | W (own)      |
| Manager chatbot                                   | R all | R all         | R (scoped)        | R (own)      |
| Weekly summary email — recipients                 | n/a   | n/a           | receives team-members'| receives own |
| User management & role assignment                 | W     | —             | —                 | —            |
| Audit log                                         | R     | R             | —                 | —            |

**The chatbot's result set is ALWAYS the same set the user would see on the dashboard for the equivalent query.** If a manager asks "How many hours did Dave work this week?" and Dave is not in the manager's scope, the chatbot must respond with a "no data accessible" message, NOT with Dave's hours.

## Functional requirements

### F1. Clock in/out & tray flow (with mood capture)

**Story F1.1 — Tray morning prompt**
**As an** Employee, **I want** the tray app to ask me each morning whether I'm starting my day, **so that** logging time is one click instead of a context switch.

**Acceptance criteria:**
- Given the Employee has opened the tray app and not yet clocked in today, when the app reaches the user's scheduled start time (default 08:00 local) OR when the user opens the tray app any time after that scheduled start, then the tray displays a "Ready to start your day?" prompt with Yes/No buttons and a 5-star mood selector (happy-face glyphs, 1–5).
- Given the prompt is showing, when the Employee clicks Yes, then a time entry is started (status=running), tagged with the selected mood (1–5; required field, default = no selection → blocks Yes button), and the web app reflects the running timer within 5 seconds (p95).
- Given the prompt is showing, when the Employee clicks No, then no timer starts, the prompt collapses, and the tray re-prompts no more than once that calendar day (no harassment loop).
- Given today is a recorded leave day for the Employee (approved leave), when the tray would normally prompt, then the prompt is suppressed entirely.

**Edge cases:**
- Tray app offline at scheduled start: prompt fires when network reconnects, with timestamp reflecting actual wall-clock time, not scheduled time.
- Employee on PTO: no prompt (see acceptance criterion 4 above).
- Multiple devices: only one tray instance per user-session may hold the active timer; opening a second instance shows the existing running timer (read-only handoff prompt to take over).
- Daylight saving transition on prompt day: prompt fires at 08:00 *local* on the new offset (no double-fire, no skip).

**Complexity:** L

---

**Story F1.2 — Tray-to-web bidirectional sync of the running timer**
**As an** Employee, **I want** the timer in my tray and the timer in the web app to always reflect the same state, **so that** I can start/stop from either surface without thinking about which one is canonical.

**Acceptance criteria:**
- Given a timer is running, when the Employee stops it from the tray, then the web app shows the timer stopped within 5 seconds (p95) without a hard refresh.
- Given a timer is running, when the Employee stops it from the web, then the tray reflects the stop within 5 seconds (p95).
- Given the tray is offline and a timer is running locally, when the tray reconnects, then any web-side state changes (e.g., a stop) are reconciled — server time is canonical, the tray reflects the server state.
- Given the Employee switches projects mid-day, when they pick a new project in the tray or web, then the prior entry is stopped and a new entry is started atomically (no overlap, no gap).
- Conflict rule: server-side, no two `time_entries` rows for one user may have overlapping `[start, end)` intervals; an attempt to start a new timer while one is running must implicitly stop the previous one (transactionally).

**Edge cases:**
- Network partition during a stop: client retries with idempotency key; server treats duplicate stop as no-op.
- Clock skew between client and server > 60s: server timestamps are authoritative; tray displays a "clock drift detected" non-blocking warning.

**Complexity:** L

---

**Story F1.3 — Mood capture**
**As an** Employee, **I want** to record my mood (1–5 happy face) at clock-in, **so that** the company can see wellbeing trends without me having to self-report individually.

**Acceptance criteria:**
- Given the morning prompt is shown, when the Employee clicks Yes, the mood field is required (Yes button disabled until mood ≥1 selected).
- Given a mood entry has been recorded for today, when the Employee re-opens the tray, then the day's mood is shown as already-captured (read-only for that day; mood is once-per-day at start-of-day).
- Mood entries are stored in a dedicated `mood_entries(user_id, date, score, created_at)` table separate from `time_entries` so retention policies apply independently.
- Given mood data is < 90 days old, the raw row is queryable (subject to RBAC: only self can see own raw mood; managers/admins see only aggregates with k≥5).
- Given mood data is ≥ 90 days old, a daily background job (the "mood retention job") aggregates it into a weekly bin per team and deletes the raw row.

**Edge cases:**
- Employee skips mood at clock-in by closing tray: clock-in is not registered (mood is required); next prompt fires per F1.1.
- Manager-overriden manual clock-in (admin-side) does not capture mood (no synthetic mood scores).

**Complexity:** M

---

### F2. Timesheets

**Story F2.1 — Timesheet entries (CRUD)**
**As an** Employee, **I want** to view, add, edit, and delete my own time entries, **so that** my submitted timesheet is accurate.

**Acceptance criteria:**
- Given an Employee is on the Timesheets page, when they load the week, then all entries for the current week (Mon–Sun in their local timezone) are listed with: date, project, task, notes, hours.
- Given an entry is in status `draft` or `rejected`, when the Employee edits any field, then the change saves and an `updated_at` audit timestamp is recorded.
- Given an entry is in status `submitted` (awaiting manager approval), `manager_approved` (awaiting finmgr final approval), or `final_approved` (locked), when the Employee attempts to edit or delete, then the action is blocked with code `ENTRY_LOCKED` and HTTP 409.
- Given an entry was `final_approved` and later an Admin reopens it via an "unlock" admin action, when the Employee re-edits, then the entry's status is set back to `draft` and the unlock action is recorded in the audit log (actor, timestamp, reason).
- Given an Employee adds a manual entry (no timer), when they save it, then the system validates: `end > start`, duration ≤ 24h, no overlap with another entry for the same user.

**Edge cases:**
- Overnight shift (start 22:00, end 06:00 next day): allowed, stored as one continuous entry; UI splits visually at midnight but stores as one row.
- DST gap (entry spans 02:00–03:00 on a spring-forward day in local TZ): UTC storage avoids the issue; UI shows actual elapsed wall hours.
- Entry beyond Sunday boundary of the displayed week: visible in the following week's view, not duplicated.

**Complexity:** M

---

**Story F2.2 — Weekly timesheet view**
**As an** Employee, **I want** a single weekly view of my time, **so that** I can review and submit a coherent week.

**Acceptance criteria:**
- Weekly view displays Mon–Sun (in employee local TZ), grouped by project, with day-column totals and a week total.
- View shows status badges: draft / submitted / manager-approved / final-approved / rejected.
- "Submit week" button is enabled only when at least one entry exists for the week and all entries are status `draft`; on click, all draft entries for that week transition to `submitted` atomically.
- After submission, a partial-rejection by manager (per F6) sends specific entries back to `rejected` while others may stay `manager_approved` — the weekly view must surface per-entry status.

**Complexity:** M

---

### F3. Manager dashboard

**Story F3.1 — Team view**
**As a** Manager, **I want** a dashboard listing the people in my RBAC scope and their week-to-date hours by project, **so that** I can see at a glance who is on track.

**Acceptance criteria:**
- Page loads in p95 < 1500ms for a manager with up to 50 anchored people.
- Listing shows: employee name, total hours WTD, hours by project (top 5 projects, rest in a "More" disclosure), # missed-punch exceptions WTD, # overtime exceptions WTD. Mood data is NOT in this view per privacy rules.
- Filters: date range, project, employee.
- Empty-scope state: if the Manager has no anchored projects or people, the page displays an explicit "no team assigned yet — contact your admin" empty state (not a blank table).

**Edge cases:**
- Manager is both project-anchored to P1 and person-anchored to Bob (who is also on P1): Bob appears exactly once (de-duped by user_id).
- Recently-removed employee (still on a P1 entry from last week): visible in historical rollups; explicitly tagged "former member of P1".

**Complexity:** L

---

**Story F3.2 — Individual employee view**
**As a** Manager, **I want** to drill into one employee in my scope and see all their projects and hours, **so that** I can reason about their workload distribution.

**Acceptance criteria:**
- Drill-in shows: employee header (name, role, anchored projects), per-project hours table for the selected date range, per-day timeline, exception list filtered to that employee.
- All projects shown are intersected with the manager's RBAC scope (no leakage). If the employee has projects outside the manager's scope, they appear as an aggregated "Other projects (3 projects)" row with hours total only, no project names.

**Edge cases:**
- Employee with zero time entries in range: page renders skeleton with "no time logged in this range".

**Complexity:** M

---

**Story F3.3 — Project rollup**
**As a** Manager, **I want** to see total hours and member breakdown per project in my scope, **so that** I can spot under/over-allocated projects.

**Acceptance criteria:**
- For each anchored project: total hours in range, hours by member, hours by task.
- Hours-vs-budget bar if the project has an `hours_budget` set (Admin/FinMgr-configured).
- Click-through to the project's time entries (still RBAC-filtered).

**Complexity:** M

---

### F4. Financial dashboard (FinMgr + Admin only)

**Story F4.1 — Project profitability**
**As a** Financial Manager, **I want** to see margin per project, **so that** I can identify unprofitable engagements.

**Acceptance criteria:**
- Page lists all active projects with: billing mode (hourly / fixed-fee / non-billable), revenue, cost-of-hours-burned, margin (absolute and %), hours, # billable hours, # non-billable hours.
- Revenue calculation:
  - Hourly: Σ (entry.hours × entry.billable_rate) for entries where `billable=true` and project's mode = hourly.
  - Fixed-fee: project.fixed_fee_amount (constant; not a function of hours).
  - Non-billable: revenue = 0.
- Cost calculation (all modes): Σ (entry.hours × employee.cost_rate_at_entry_date). Cost rate is point-in-time — entries are costed at the rate effective on the entry's date.
- Currency: stored per-project (ISO 4217). [ASSUMED: a single reporting currency is configured at org level and conversions use a stored daily FX rate table — if multi-currency is not required v1, all projects must share one currency and the FX table is omitted.]
- Filters: date range, client, project, billing mode, project owner.

**Edge cases:**
- A cost rate is changed mid-week: entries before the change are costed at the old rate, entries after at the new rate. The rate-history table is the source of truth.
- A project switches billing mode mid-engagement: each entry uses the project's billing mode at the time of the entry (mode-history on the project).

**Complexity:** L

---

**Story F4.2 — Team and individual margin views**
**As a** Financial Manager, **I want** margin rolled up by team and by individual employee, **so that** I can identify highly-utilised, low-margin people.

**Acceptance criteria:**
- Team view: groups by manager (top-level anchored manager). Per group: hours, revenue (sum across their projects), cost, margin, utilisation% (= billable hours / capacity hours; capacity = scheduled hours).
- Individual view: per-employee row with hours, billable hours, non-billable hours, revenue attributed, cost (hours × cost rate), margin contribution, utilisation%.
- Sortable by every metric. Default sort: margin% ascending (worst first).

**Edge cases:**
- Employee with zero capacity in range (on leave entire range): utilisation displays as "n/a", not 0% or NaN.
- Employee anchored to multiple managers: appears under each anchor team (with a footnote indicator "shared with N teams") — totals do not double-count at the org rollup level.

**Complexity:** L

---

**Story F4.3 — Cost rates & billable rates management**
**As an** Admin or Financial Manager, **I want** to set and update cost rates and billable rates, **so that** profitability reflects current economics.

**Acceptance criteria:**
- Cost rate per employee: editable by Admin and FinMgr only. Edit creates a new row in `employee_cost_rates(user_id, rate, effective_from, effective_to, currency, created_by, created_at)`. Past entries are not retroactively re-costed; new effective rate applies from `effective_from` forward.
- Billable rate per project (and optionally per task within project): same history pattern in `project_billable_rates`.
- Every cost-rate or billable-rate edit appends to the audit log (actor user_id, before/after values, timestamp).
- A Manager or Employee attempting to GET a cost-rate endpoint receives HTTP 403 with code `RBAC_FORBIDDEN`.

**Complexity:** M

---

### F5. Leave / time-off booking

**Story F5.1 — Employee books leave**
**As an** Employee, **I want** to book a leave request inside Harvoost, **so that** my time-off is reflected in my timesheet and visible to my manager.

**Acceptance criteria:**
- Form fields: leave type ([ASSUMED: enum of `annual`, `sick`, `unpaid`, `other` — finalised at architecture]), start date, end date (inclusive), optional note, half-day flag (AM/PM if applicable).
- Validation: end ≥ start; no overlap with an already-pending or approved leave for the same user; start ≥ today (no back-dated leave bookings — Admin override available for stage-2 entries).
- On submit, leave request enters status `pending`; the Employee's direct managers (all of them, per RBAC anchor) are notified by in-app notification and email.
- The leave request does NOT yet decrement any balance — Harvoost does not track balances in v1; BambooHR remains the system of record. A flagged seam exists for the future Bamboo bridge (see "Integration seams" below).

**Edge cases:**
- Leave spanning a weekend or public holiday: leave days are stored as a date range; what counts as a "working day" within that range is rendered at report-time (using a `working_days` calendar that Admin maintains, or [ASSUMED: a Mon–Fri default if no calendar is configured]).
- Employee with no manager anchored: leave request notifies Admin as a fallback approver.

**Complexity:** M

---

**Story F5.2 — Manager approves leave**
**As a** Manager, **I want** to approve or reject a leave request from my anchored employees, **so that** they get a timely answer.

**Acceptance criteria:**
- Manager sees pending leave requests in their dashboard inbox.
- Approve/Reject buttons; reject requires a comment (≥10 chars).
- On approval: leave request transitions to `approved`; the corresponding date range is marked on the employee's calendar; the tray morning prompt is suppressed for those dates (per F1.1).
- Approved leave is not pushed to BambooHR in v1 — the request payload is stored in Harvoost with a `bamboo_sync_status` field defaulting to `pending` (the future Bamboo worker will read this).

**Edge cases:**
- Approved leave that the employee tries to cancel: requires a new "cancellation request" which the manager re-approves.
- Manager goes on leave themselves: any pending requests they own should escalate to Admin after 48h (or to a co-anchored manager if one exists). [ASSUMED: 48h SLA — finalise in architecture.]

**Complexity:** M

---

**Story F5.3 — Bamboo integration seam (NOT IMPLEMENTED v1, but designed)**
**As an** Architect, **I want** the leave model to be Bamboo-compatible from day one, **so that** the v2 bridge is purely additive.

**Acceptance criteria for the seam:**
- `leave_requests` table includes: `bamboo_request_id` (nullable), `bamboo_sync_status` (enum: `pending`, `synced`, `failed`, `not_applicable`), `bamboo_synced_at` (nullable).
- A `LeaveSyncProvider` interface exists in the codebase with a `NoOpLeaveSyncProvider` v1 implementation; the future `BambooLeaveSyncProvider` slots in via DI.
- Architecture document calls out the planned Bamboo Payment Docs endpoint to be consumed (https://docs.bamboopayment.com/mcp) but does not implement it.

**Complexity:** S (interface only)

---

### F6. Two-stage approval workflow

**Story F6.1 — Stage 1: Manager approval**
**As a** Manager, **I want** to approve or reject each of my anchored employees' submitted timesheets, **so that** finance gets a vetted weekly batch.

**Acceptance criteria:**
- Manager's "Approvals" inbox lists submitted weeks for each anchored employee.
- Manager can approve a whole week (all entries → `manager_approved`) or per-entry (some → `manager_approved`, some → `rejected` with required reject reason ≥10 chars).
- An employee whose week is partially approved is notified per-entry of which entries need re-work.
- An entry rejected at stage 1 returns to `draft` status (editable) with the rejection comment surfaced on the entry.
- A manager who is also a financial manager [ASSUMED: a single user CAN hold both roles; this is allowed] may pre-approve their own employees but the system blocks stage-2 self-approval — i.e., the same user_id cannot be both the stage-1 approver AND the stage-2 approver on the same entry. Stage-2 must be a *different* user with FinMgr role.

**Complexity:** M

---

**Story F6.2 — Stage 2: Financial Manager final approval**
**As a** Financial Manager, **I want** to perform final approval on manager-approved timesheets, **so that** entries are locked for billing and payroll downstream.

**Acceptance criteria:**
- FinMgr's "Final Approvals" inbox lists all `manager_approved` weeks.
- On final approve, entries → `final_approved`; entries become read-only for the employee.
- On final reject (with reason ≥10 chars), entries → `rejected`; flow to the relevant manager, who triages back to the employee.
- Audit log captures every state transition: actor, from-state, to-state, timestamp, optional reason.

**Complexity:** M

---

**Story F6.3 — Admin unlock**
**As an** Admin, **I want** to unlock a final-approved entry, **so that** a genuine correction (typo, mis-coded project) can be made post-hoc.

**Acceptance criteria:**
- Admin-only action; requires a reason (≥20 chars).
- Unlocked entry → `draft`; employee can re-edit and re-submit.
- Audit log records the unlock with full context.

**Complexity:** S

---

### F7. Scheduling / shift assignment

**Story F7.1 — Default schedule**
**As an** Employee, **I want** my schedule to default to 08:00–17:00 (with 1hr lunch) in my local timezone, **so that** I don't have to configure anything to start.

**Acceptance criteria:**
- On user creation, a default `schedule_template` is bound: working days Mon–Fri, start 08:00, end 17:00, lunch 12:00–13:00, all interpreted in the user's IANA timezone.
- Tray morning prompt timing (F1.1) and weekly summary delivery time (F11) read from this schedule.
- Schedule is rendered to the employee on their profile/schedule page.

**Complexity:** S

---

**Story F7.2 — Manager schedule override (scoped)**
**As a** Manager, **I want** to override the schedule for one of my anchored employees on a specific date or date range, **so that** I can adjust for support coverage needs.

**Acceptance criteria:**
- Manager can create a `schedule_override(user_id, date_range, new_start, new_end, new_lunch, reason)`.
- Override must be for a user in the manager's RBAC scope; otherwise HTTP 403.
- Override is per-user only at the manager level (managers cannot do project-wide or company-wide overrides — that's Admin/FinMgr).
- Override creation notifies the employee.

**Complexity:** M

---

**Story F7.3 — Admin / FinMgr broad overrides**
**As an** Admin or FinMgr, **I want** to override schedules at project-wide or org-wide scope, **so that** I can roll out shift policies (e.g., "all of project P1 moves to 09:00–18:00 for July").

**Acceptance criteria:**
- Admin or FinMgr can create overrides scoped to: a project (applies to all current members), a list of employees, or all employees.
- Conflict resolution: most-specific scope wins. Employee-level override > project-level > org-level > default template. Same-scope conflicts are rejected at create time (no overlapping overrides for the same scope+date).

**Complexity:** M

---

**Story F7.4 — Schedule dashboard**
**As a** Manager (scoped) or Admin/FinMgr (org-wide), **I want** to see a dashboard view of who is scheduled when, **so that** I can plan coverage.

**Acceptance criteria:**
- Three tabs: Company, Team (= scope), Individual.
- Calendar view (week or month) with one row per employee (or grouped by project on a separate view) and shaded blocks for scheduled hours, with hover-tooltip detail (start/end in viewer's TZ + employee's TZ, lunch window, override reason).
- Manager's scope filter is enforced on Team and Individual tabs.

**Complexity:** L

---

### F8. Exception handling

**Story F8.1 — Missed-punch detection**
**As a** Manager, **I want** missed punches to be flagged on my dashboard, **so that** I can prompt the employee to correct.

**Acceptance criteria:**
- A daily batch job at [ASSUMED: 02:00 server-UTC, configurable] computes missed-punch exceptions: for each employee with a scheduled working day in the previous calendar day's local TZ, if no time entries exist for that day AND no approved leave covers the date, flag a `MISSED_PUNCH` exception.
- Exceptions appear in the manager dashboard (scoped) and in the employee's own dashboard (own only).
- Employees can resolve a missed-punch by creating a manual entry for the day; on save, the exception status flips to `resolved` and the resolution is logged.

**Complexity:** M

---

**Story F8.2 — Overtime detection**
**As a** Manager, **I want** overtime to be flagged, **so that** I can intervene on burnout risk.

**Acceptance criteria:**
- Overtime rule (default): >10h logged in a single calendar day OR >50h in a 7-day rolling window in employee local TZ. Rule thresholds are admin-configurable in v1 (per-org, not per-user). [ASSUMED: 10h and 50h defaults — finalise with FinMgr stakeholder.]
- Detection runs in the same nightly batch as F8.1, AND in real-time when a time entry is closed (so the manager sees today's overtime today, not tomorrow).
- Exception type `OVERTIME_DAY` or `OVERTIME_WEEK` is raised.

**Complexity:** M

---

**Story F8.3 — Anomaly detection**
**As a** Manager, **I want** unusual patterns (e.g., a sudden 0-hour day after weeks of consistent 8h days) flagged, **so that** I can ask if everything's okay.

**Acceptance criteria:**
- Anomaly rule (v1, simple): for each employee, compute trailing-4-week mean and stdev of daily hours; flag any working day whose hours differ from the mean by > 2σ as `ANOMALY_LOW` or `ANOMALY_HIGH`.
- Exceptions are advisory (do not block anything) and surface in the same Exceptions table.
- [ASSUMED: 2σ threshold is fine for v1; ML-based detection is explicitly out of scope.]

**Complexity:** M

---

### F9. Reporting

**Story F9.1 — Detailed activity report**
**As an** Admin / FinMgr / Manager (scoped) / Employee (own), **I want** a detailed report of time entries, **so that** I can answer ad-hoc questions and export for downstream tools.

**Acceptance criteria:**
- Filters: date range, client, project, task, employee, billing mode, billable yes/no.
- Columns (one row per entry): Date, Client, Project, Task, Notes, Hours, Hours rounded, Billable, Invoiced ([ASSUMED: this column is always blank in v1 since invoicing is OOS — kept in the schema for Harvest compatibility]), Approved, First name, Last name, Roles, Employee, Billable rate, Billable amount, Cost rate, Cost amount, Currency, External reference URL ([ASSUMED: blank v1], Project code, Department, Estimate.
- Rows are server-side paginated; full export delivered as Excel (see F9.3).

**Complexity:** M

---

**Story F9.2 — Time report (rolled up)**
**As a** Manager or FinMgr, **I want** a rolled-up time report by project / employee / task, **so that** I can see summaries without scrolling through entries.

**Acceptance criteria:**
- Group-by options: project, employee, task, client, day, week.
- Aggregate columns: Hours, Billable hours, Non-billable hours, Billable amount, Cost amount, Margin (if user has financial visibility).
- Drill-down to underlying entries.

**Complexity:** M

---

**Story F9.3 — Excel export (Harvest-compatible)**
**As any** authenticated user (scoped to their RBAC), **I want** to export the report to .xlsx, **so that** I can share or load into another tool.

**Acceptance criteria:**
- Endpoint accepts the same filter set as the on-screen report.
- Output file format: .xlsx (single sheet, headers row, data rows).
- **Column schema and order MUST match Harvest's detailed time-report CSV/XLSX schema exactly** (column names verbatim, including casing). Reference: https://www.getharvest.com — exact column list to be locked at architecture phase but expected to include at minimum: Date, Client, Project, Project Code, Task, Notes, Hours, Hours Rounded, Billable, Invoiced, Approved, First Name, Last Name, Employee, Billable Rate, Billable Amount, Cost Rate, Cost Amount, Currency, External Reference URL.
- Cost columns (Cost Rate, Cost Amount) are omitted from the export for users without financial visibility (Manager, Employee).
- File generation is bounded: ≤ 100,000 rows synchronous (download immediately); > 100,000 rows is async (job + email link). [ASSUMED: 100k threshold — confirm with architect.]

**Complexity:** M

---

### F10. Manager chatbot (LLM-powered, RBAC-aware)

**Story F10.1 — Natural language Q&A**
**As a** Manager (or any role within their scope), **I want** to type a question and get an answer drawn from my scoped data, **so that** I can self-serve common questions without building a report.

**Acceptance criteria:**
- A chat panel is exposed in the manager dashboard (and a scoped variant in the FinMgr / Admin / Employee dashboards — same engine, different RBAC scope).
- The chatbot accepts free-text questions, e.g.:
  - "How many hours did Jacques work this week?"
  - "Which of my projects went over budget last month?"
  - "Show me overtime exceptions for my team in the last 2 weeks."
- The LLM translates intent to a **bounded tool call** from a fixed registry of parameterised query tools (e.g., `get_user_hours(user_id, date_range)`, `list_exceptions(scope, type, date_range)`, `project_rollup(project_id, date_range)`). The LLM does NOT generate SQL.
- Every tool function is implemented to take the requesting user's identity as a parameter and runs the same RBAC filter as the dashboard endpoints. Tool results are stable and deterministic given the same inputs.
- Response includes both natural-language summary AND structured data (a small table) for verifiability.

**Critical security acceptance criteria:**
- The LLM never receives raw RBAC-bypassing data. It receives only what the tools return. Prompt injection in user input cannot widen scope, because the LLM cannot select which user_id to query — the requesting user's ID is bound at the application layer, not via the LLM prompt.
- Out-of-scope queries return: "I can only answer about people and projects you have access to. {target_name} is not in your visible scope." — no leakage of existence (i.e., do not say "Dave exists but you can't see him"; phrase as if the target may or may not exist).
- All chatbot tool invocations are logged (user, prompt, tool, params, result row count) to an audit table.

**Edge cases:**
- Question the LLM cannot map to any tool: respond with "I'm not sure how to answer that — try rephrasing, or use the dashboard filters."
- LLM API timeout or 5xx: respond with a degraded "service unavailable" message; do NOT silently swallow.
- Cost cap: per-user daily token budget [ASSUMED: 50k tokens/user/day, configurable], beyond which the user gets a polite rate-limit message.

**Complexity:** L

---

### F11. Autonomous weekly summary

**Story F11.1 — Per-employee summary email**
**As an** Employee, **I want** an automatic Monday-morning summary of what I spent my time on last week plus a motivational quote, **so that** I start the week with context.

**Acceptance criteria:**
- Trigger: Monday 08:00 in each recipient's local timezone (use the IANA TZ on their profile). A scheduler enqueues per-user delivery jobs at the appropriate UTC moment.
- Content: prior week's (Mon–Sun in the user's TZ) totals — total hours, top 3 projects by hours, total mood-average (own), one motivational quote drawn from a bundled curated list (no LLM-generated quote, no external API).
- Body generation: LLM-rendered prose summarising the rollup (e.g., "You logged 38.5 hours last week, mostly on Project Atlas (22h) and Internal Ops (8h)…"). On LLM failure (timeout, 5xx, content filter, missing API key), the system falls back to a deterministic Jinja-style template using the same data, and tags the email body with `[fallback summary]` for telemetry.
- Delivery: SMTP/SendGrid email. Email logged in `email_delivery_log(user_id, summary_period, status, sent_at, mode='llm'|'template', message_id)`.
- Failure mode: if email send fails entirely (e.g., bad address, SMTP down), retry 3x with exponential backoff over 30 min; record `failed` after retries exhaust; surface to Admin via a daily digest.

**Edge cases:**
- Employee with zero hours last week: summary still sends ("You didn't log any time last week — was that intentional?"), unless they were on full-week approved leave (then summary is suppressed).
- Employee started midweek: summary based on partial week, with a contextual note.
- [ASSUMED: weekly summary is **opt-out**, not opt-in. Each user has a `weekly_summary_opt_out` flag (default false). Setting flag = true stops the user's summary AND the manager's copy *of that user*.]

**Complexity:** L

---

**Story F11.2 — Direct-manager copy**
**As a** Manager, **I want** a copy of each of my anchored employees' weekly summary, **so that** I have ambient context on my team without dashboard-diving.

**Acceptance criteria:**
- For each employee whose summary is generated, the system also enqueues a delivery for each of that employee's anchored managers (via the same per-recipient-local-TZ rule).
- Manager's copy is the same body as the employee's, but flagged "Team summary: {employee}" in the subject line, and **does not include mood data** (privacy rule).
- If a manager is anchored to N employees, they receive N separate emails (not a digest, in v1). [ASSUMED: separate emails — a digest is a v2 nice-to-have.]

**Complexity:** M

---

## Non-functional requirements

### Scale
- 50–500 concurrent named users, single tenant. Burst expectation: ~80% of users active during business hours; peak read throughput on dashboards.
- Database sizing target: assume 500 users × 5 entries/day × 365 days × 3 years ≈ 2.7M time entries. Indexes on (user_id, date), (project_id, date), and (status) are mandatory.

### Performance
- Dashboard list endpoint: p95 < 500ms, p99 < 1500ms at 500-user scale.
- Tray ↔ web sync round-trip: p95 < 5s.
- Chatbot response (end-to-end including LLM call): p95 < 10s; p99 < 20s.
- Excel export ≤ 10,000 rows: p95 < 5s synchronous; > 100k rows: async only.

### Availability
- [ASSUMED: 99.5% v1 SLO (~3.6h downtime/month). Justification: internal-facing single-tenant, no external customer SLA; 99.9% would force HA Postgres which is overkill for v1. Revisit in v2.]
- Scheduled maintenance windows allowed outside business hours of the primary region.

### Security
- **Authentication:** Entra ID OIDC SSO only. No local accounts. MFA enforcement inherited from the Azure AD tenant — Harvoost does not add a second factor.
- **Authorisation:** RBAC at the API layer; row-level filtering applied in every query function (no bypass). Manager visibility computed server-side from `project_managers` and `user_managers` join tables (see RBAC matrix).
- **Sensitive data:** cost rates and billable rates are queryable only by Admin and FinMgr roles. Any endpoint returning a cost-rate field must check role explicitly; failing-closed is the default.
- **Mood data:**
  - Raw mood entries < 90 days old: queryable only by the entry owner.
  - Aggregated mood (any time): visible to managers (scoped) and admins ONLY at k-anonymity threshold k ≥ 5 (an aggregate over fewer than 5 employees returns "not enough data").
  - Raw mood entries ≥ 90 days old: automatically aggregated into weekly bins (per team) and the raw row is deleted by a daily job. This is non-recoverable.
- **Secrets:** all secrets (DB connection strings, LLM API keys, SMTP creds, Entra ID client secret) stored in Azure Key Vault; pulled at runtime by managed identity. No secrets in env files committed to git.
- **Audit log:** append-only table capturing every approval transition, every cost/billable-rate edit, every admin unlock, every role assignment, every chatbot tool invocation. Retention: 7 years.
- **Transport:** TLS 1.2+ everywhere, including tray ↔ API.
- **Data at rest:** Azure-managed encryption (AES-256) on the Postgres flexible server and Blob Storage.

### Timezones
- Per-user IANA timezone string stored on `users.timezone` (default to org's primary TZ if missing).
- All timestamps stored UTC in the database. Rendered in viewer's local TZ in the UI (configurable: "my TZ" vs "entry's TZ" toggle for managers).
- Schedule template times are interpreted in the **assigned-employee's** TZ.
- Weekly summary delivery is per-recipient local Monday 08:00.

### Data retention
- Time entries: retained indefinitely (financial record).
- Mood entries: raw 90 days; weekly aggregates indefinitely.
- Audit log: 7 years.
- Email delivery log: 1 year.
- Chatbot tool invocation log: 1 year.

### Observability
- All API endpoints emit Application Insights traces with user_id, role, endpoint, latency, RBAC scope size.
- All scheduled jobs (mood retention, exception detection, weekly summary) emit success/failure metrics.

### Internationalisation
- v1 UI: English only. [ASSUMED: i18n is out of scope; copy is English.] Currency and date formatting respect locale.

### Browser & client support
- Web: latest 2 versions of Chrome, Edge, Firefox, Safari.
- Tray: Electron, latest stable, on Windows 10/11, macOS 12+, Ubuntu 22.04+.

## Integration seams (designed v1, implemented later)

- **BambooHR leave bridge:** `LeaveSyncProvider` interface, v1 NoOp impl. Schema-ready (`bamboo_*` columns on `leave_requests`). Endpoint reference: https://docs.bamboopayment.com/mcp.
- **Future invoicing:** the `Invoiced` column exists in the export schema for Harvest compatibility but is always blank v1; reserved for a future v2 link to invoice line items.
- **Public API for external integrations:** Excel export is the only export surface in v1.

## Out of scope (explicit)

- BambooHR live integration (seam only; bridge is v2).
- Voice in the conversational interface (text chat only v1).
- Multi-tenant support (single-tenant v1 only).
- Native mobile apps (iOS/Android). Mobile is browser-only v1.
- Free-form SQL from the chatbot or any LLM-driven query construction outside the fixed tool registry.
- Public REST/GraphQL API for third-party consumers beyond the Excel export endpoint.
- Invoicing, payroll, expense tracking.
- ML-based anomaly detection (rule-based only v1).
- i18n / multi-language UI.
- Multi-currency reporting with live FX (assumes single-currency org v1; see F4.1 [ASSUMED]).
- Mood data dashboards beyond aggregated trendlines (no per-individual mood views, even for managers).
- Digest-style weekly summary email for managers (per-employee email per F11.2 only).
- HA/multi-region failover (single-region v1 per the 99.5% SLO).

## Risks

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| RBAC bypass via LLM tool chaining (the LLM coerces a tool to return out-of-scope data) | M | H | Bind requesting user_id at app layer (not via LLM prompt); every tool re-applies RBAC filter; integration tests assert out-of-scope queries return empty / "no access" with cross-role test fixtures. |
| Tray ↔ web state divergence under poor network | M | M | Server-side `idempotency_key` on start/stop endpoints; server is canonical for time-entry boundaries; tray displays drift warnings. Reconciliation tests in CI. |
| Mood data leak (manager sees individual mood despite aggregation rule) | L | H | k≥5 threshold enforced in the aggregation query, not in the UI; row-level mood reads disabled for non-owner roles via DB row-level security or service-layer guard. Security review must specifically test this. |
| Cost rate exposed to a Manager/Employee via report or export | L | H | RBAC check on every cost-rate-bearing endpoint; export schema strips cost columns server-side based on requester role; integration tests assert non-financial roles never see Cost Rate / Cost Amount. |
| LLM API outage breaks the weekly summary | M | M | Deterministic template fallback (F11.1); emails still go out, telemetry flagged for follow-up. |
| LLM cost runaway (a user spamming the chatbot) | M | M | Per-user daily token budget [ASSUMED 50k]; rate-limiter at the chatbot endpoint. |
| DST transition double-fires or skips the morning prompt | M | M | Compute scheduled-start as a future UTC instant per day using the user's IANA TZ via a tested library (e.g., Luxon); explicit DST unit tests. |
| Cascading manager visibility misimplemented (transitive vs explicit) | M | H | The rule is spelled out unambiguously in this doc with a worked example; architect's data-model and API design must reference this section verbatim; e2e tests with multi-manager fixtures. |
| Harvest column-schema drift (Harvest changes their CSV) | L | L | Pin to current schema; document the version; export schema lives in a single constants file for easy update. |
| Bamboo integration assumed-shape changes before v2 | M | L | Keep the seam minimal (one interface, one column set); don't pre-implement Bamboo specifics. |
| Mood retention job fails silently, breaching the 90-day promise | L | H | Job emits success/failure to Application Insights; alert on >36h since last successful run; smoke test in CI runs the job on a fixture DB. |
| Self-approval (same user is both Manager and FinMgr) collapses two-stage to one-stage | M | M | Explicit guard in F6.1: stage-2 approver must be a different user_id from stage-1 approver, even if one user holds both roles. |
| Single-region Azure region outage | L | M | Documented limitation in the 99.5% SLO; backups to a paired region; v2 HA story is a known follow-up. |
| Open mood data being a vector for re-identification even at k=5 (e.g., a manager with only 5 reports can infer one) | L | M | Document the residual risk; consider k≥5 PLUS a minimum-aggregation-window of 1 week to reduce inference. Revisit threshold in security review. |
| Per-user TZ on weekly-summary delivery creates thundering-herd at common offsets (e.g., 08:00 in CET) | M | L | Job queue with per-user enqueue-at-UTC-instant; horizontal scaling of summary worker; SMTP rate limit observed. |

## Open assumptions

- [ASSUMED: 99.5% availability SLO v1] — single-tenant internal app; HA Postgres is overkill at the v1 scale. Revisit in v2.
- [ASSUMED: single reporting currency org-wide] — multi-currency with FX is significant scope; defer to v2 unless the org explicitly needs it.
- [ASSUMED: Mon–Fri default working calendar for leave-day counting] — actual calendar (with public holidays) is admin-configurable but defaults to Mon–Fri.
- [ASSUMED: 48h escalation SLA when a manager-on-leave holds a pending approval] — tune in production.
- [ASSUMED: a user can hold multiple roles (e.g., Manager + FinMgr)] — but the same user cannot self-approve across stages.
- [ASSUMED: leave type enum = `annual`, `sick`, `unpaid`, `other`] — Bamboo's actual taxonomy will replace this in v2; design the column as a free-form string with a v1-validated enum.
- [ASSUMED: 50k tokens/user/day chatbot budget] — sanity-check at production usage.
- [ASSUMED: weekly summary is opt-out (default on)] — opt-in would risk low coverage; opt-out is the saner default with a clearly-labelled user setting.
- [ASSUMED: managers receive one email per employee, not a digest] — v2 digest format if managers complain.
- [ASSUMED: 100k rows is the sync/async export threshold] — pin during architecture once we know the XLSX writer's memory footprint.
- [ASSUMED: 10h daily / 50h weekly overtime threshold] — finalise with FinMgr stakeholder; the rule is admin-configurable.
- [ASSUMED: 2σ anomaly threshold] — rule-based heuristic, replace with ML in v2 if value warrants.
- [ASSUMED: 02:00 server-UTC nightly batch window] — coordinate with deploy region's off-hours.
- [ASSUMED: external reference URL / project code / department / estimate are blank-but-present columns in the Excel export for Harvest compatibility] — populated only if the org configures the corresponding optional fields.
- [ASSUMED: i18n out of scope v1, English copy only].
- [ASSUMED: Azure region = West Europe or South Africa North] — final choice with architect based on user latency.
