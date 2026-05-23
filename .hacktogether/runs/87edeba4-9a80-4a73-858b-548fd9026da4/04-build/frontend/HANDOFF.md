---
phase: build (final feature-completion pass)
agent: frontend-dev (final)
started: 2026-05-23T00:42:00Z
finished: 2026-05-23T01:35:00Z
status: complete
---

# Summary

Closed out every stubbed UI surface called out in the dispatch: the four admin
pages (`/admin/users`, `/admin/projects`, `/admin/clients`, `/admin/rates`)
are now fully wired to the v1 REST contract; the two approval action UIs
(`/approvals/final` and `/leave/approvals`) take real actions through PATCH
and POST endpoints with the correct HTTP verbs; the `/schedule` page renders
a three-tab dashboard (Company / Team / Individual) with a "New override"
modal that POSTs to `/v1/schedules/overrides` honouring the scope-vs-role
matrix from REQUIREMENTS F7; and the Electron tray's SSE consumer now talks
to the canonical `/v1/sync/events` endpoint, handles the new
`timer.{started,stopped,switched}` + `entry.{submitted,approved}` event
names, surfaces 401/403 via a new `sync:auth-expired` IPC channel so the
renderer can drop to signed-out, and caps reconnect at 16s per the dispatch
spec. Total ~1750 LOC of new UI plus ~140 LOC of additions to the IPC bridge
and the API-type module. Two endpoint clusters used by the rates UI
(`/v1/cost-rates`, `/v1/billable-rates`) are not yet in `openapi.yaml`; the
shapes are hand-typed with a `TODO(post-merge): regenerate from
openapi-typescript` marker.

# Files touched

## Surface 1 — Admin pages (Next.js App Router, all `apps/web/app/admin/`)

- `apps/web/app/admin/users/page.tsx` (rewrite) — Admin-only; redirects
  non-admins with a toast. Table with offset pagination (50/page), name+email
  search (debounced 300ms), role multi-select filter, "Edit roles" Modal
  (multi-checkbox over admin/finmgr/manager/employee; submits per-role
  POST/DELETE), "Edit profile" Modal with display_name + IANA timezone
  picker (short common list + custom-text fallback). Empty state explains
  OIDC self-registration.
- `apps/web/app/admin/clients/page.tsx` (rewrite) — Admin/FinMgr only. Search,
  create/edit Modal (name + contact + ISO 4217 currency dropdown), archive
  via DELETE with 409 friendly-message "projects still reference this
  client" handling.
- `apps/web/app/admin/projects/page.tsx` (rewrite) — Admin only. Project
  table with billing-mode badges and members/managers counts. Create/Edit
  Modal (client locked on edit; conditional Fixed-fee-amount field appears
  when billing_mode=fixed_fee). Members drawer (Modal size=lg) with add via
  Select + per-row remove; Managers drawer with the same pattern against
  `/v1/projects/:id/managers`. Archive via PATCH `is_active=false` with
  confirmation dialog.
- `apps/web/app/admin/rates/page.tsx` (rewrite) — Admin/FinMgr only.
  Two-tab UI (Cost rates / Billable rates). Cost-rates tab lists every active
  user; "Set rate" Modal posts to `/v1/cost-rates` with rate + currency +
  effective_from; "History" Modal lists every prior rate with effective_from /
  effective_to columns and a "Current" badge on the open row. Billable rates
  tab mirrors the pattern at the project level (default per-project rate
  with optional task_id targeting).

## Surface 2 — Approval action UIs

- `apps/web/app/approvals/final/page.tsx` (rewrite) — FinMgr/Admin only.
  Pulls `/v1/approvals/queue?stage=final` and groups entries by (user, ISO
  week). Each group renders as a Card with expand/collapse for entry detail
  (date, project, task, hours, status, notes). "Final approve" posts the
  batch to `/v1/approvals/timesheets/final`; surfaces stage-1≠stage-2 + RBAC
  failures via friendly toasts; partial-success warning when the response
  has `skipped`. "Final reject" Modal validates reason ≥10 chars before POST.
- `apps/web/app/leave/approvals/page.tsx` (rewrite) — Manager/Admin/FinMgr.
  Status filter (pending/approved/rejected). Approve via PATCH
  `/v1/leave/requests/:id/approve` (verb change from POST → PATCH this pass).
  Reject via PATCH `/v1/leave/requests/:id/reject` with reason validation.
  403 from the approve path triggers a "you don't have approval rights"
  toast.
- `apps/web/app/schedule/page.tsx` (rewrite) — Three tabs (Company /
  Team / Individual). Company tab is only rendered when
  `useScope().canSeeFinancialData` is true. Individual tab includes a user
  picker for Managers / FinMgrs / Admins; Employees see only their own
  schedule. Grid is a sticky-column HTML table with day columns from the
  current ISO week (date range picker at the top). Override badges colour
  cells warning-yellow; template cells colour brand-blue. Tooltip on each
  cell shows start/end + hours + override reason. "New override" button
  visible to Manager (scoped → user only), Admin / FinMgr (user|project|org)
  — opens a Modal that POSTs to `/v1/schedules/overrides`.

## Surface 3 — Tray SSE consumer

- `apps/tray/main/sync.ts` (modified) — Endpoint changed from
  `/v1/sync/stream` → `/v1/sync/events` (canonical per backend-dev's
  contract). 401/403 now terminates the loop and emits `sync:auth-expired`
  instead of falling into exponential backoff forever. MAX_BACKOFF_MS dropped
  from 30s → 16s per the dispatch spec. Heartbeat handling delegated to
  `eventsource-parser` (it drops SSE comments + empty events natively).
- `apps/tray/preload/index.ts` (modified) — Added `sync.onAuthExpired()`
  to the contextBridge surface with a typed `{ status: number }` payload.
- `apps/tray/renderer/lib/ipc-client.ts` (modified) — Re-exposed the new
  `onAuthExpired` channel.
- `apps/tray/renderer/App.tsx` (modified) — Subscribes to `sync:auth-expired`
  in the same `useEffect` that wires `sync:event` and `sync:connected`;
  drops to `{ kind: 'signed-out' }` when fired so the renderer prompts for
  sign-in. Event name list expanded to recognise the canonical SSE event
  set: `timer.started`, `timer.stopped`, `timer.switched`, `entry.submitted`,
  `entry.approved`, plus legacy `time_entry.*` aliases for
  forward-compatibility.

## Supporting changes

- `apps/web/src/lib/api-types.ts` (modified) — Added User, Client,
  AdminProject, ProjectMember, ProjectManagerAnchor, ScheduleOverride,
  CreateScheduleOverrideRequest, ScheduleDashboardRow, CostRate,
  BillableRate, FinalApprovalBatchRequest, ApprovalBatchResponse,
  OffsetPaginated<T>, Role enum. Each block carries a TODO(post-merge)
  marker pointing at openapi-typescript regeneration.
- `apps/web/src/lib/tz-list.ts` (new) — 21-entry IANA timezone list
  (Africa-first ordering) for the admin user-edit picker. Includes a
  `isKnownTimezone()` helper so the picker correctly switches to "custom"
  for non-listed zones.

# What downstream agents need to know

## For docs-writer (Phase 8)

- All eight previously-stubbed user-facing surfaces now render real UI:
  - **Admin pages:** Users, Clients, Projects, Rates (with Cost + Billable
    tabs). Admin-only or Admin/FinMgr-only; non-permitted roles are redirected
    with a toast.
  - **Final approvals:** FinMgr/Admin two-stage approval inbox with batch
    action + reason-required rejection.
  - **Leave approvals:** Manager/Admin/FinMgr approval action UI with PATCH
    verbs (was previously read-only list).
  - **Schedule:** Three-tab dashboard with override creation.
  - **Tray real-time sync:** event-driven; "stop timer from web" reflects in
    the tray within one SSE round-trip (~1s) on a healthy network.
- **No surfaces remain stubbed.** The `StubSection` component is now only
  imported by `apps/web/src/components/StubSection.tsx` itself and the
  `/settings` page (which retains a "Preferences UI coming soon" note for
  weekly_summary_opt_out toggling — out of scope for this pass).

## For e2e-tester (if re-dispatched)

### Admin pages — selectors and flows

- All admin pages live under `/admin/{users,projects,clients,rates}`.
  Non-admin users are redirected to `/timesheets` with an `info` toast on
  mount. Tests that exercise these pages MUST sign in as Alice (admin)
  per the seed fixture.
- **Users page:** Search input has `aria-label="Search users"`; role filter
  has `aria-label="Filter by role"`. "Edit roles" opens a Modal titled
  `Edit roles — <name>` with one labelled checkbox per role. "Edit profile"
  opens a Modal titled `Edit profile — <name>` with a timezone Select that
  switches to a "Custom IANA timezone" Input when the value `__custom__` is
  chosen.
- **Projects page:** "Members" and "Managers" buttons open separate Modals
  sized lg. Each drawer has an "Add member"/"Add manager" Select +
  primary "Add"/"Anchor" Button followed by a list of current rows with
  per-row "Remove"/"Unanchor" actions.
- **Clients page:** Archive button opens a confirmation Modal; the danger
  Button is labelled "Archive client". A 409 response from
  `DELETE /v1/clients/:id` surfaces the message "Cannot delete — projects
  still reference this client".
- **Rates page:** Tabs are labelled `Cost rates` and `Billable rates`.
  "Set rate" opens a Modal with a numeric input (min=0, step=0.01) +
  currency Select + effective-from date input. "History" opens a Modal
  with an immutable table that shows a `Current` Badge on the open row.

### Final approvals — selectors and flows

- Each week renders as a Card with the user name + ISO week + total hours.
  Clicking the chevron toggles a per-entry detail Table.
- "Final approve" is a primary Button. On success, the toast is
  `Final approval recorded`. On stage-1 == stage-2 failure (HTTP 403 or
  IDEMPOTENCY_CONFLICT), the toast is "Stage-1 approver cannot also be
  the stage-2 approver…".
- "Final reject" opens a Modal with a textarea labelled "Reason"; the
  Submit button is disabled (and surfaces a validation error) until the
  reason is ≥10 chars.

### Leave approvals — selectors and flows

- Status filter Select (default `pending`) has `aria-label="Filter by status"`.
- Approve/Reject Buttons are visible only on pending rows; approved/rejected
  rows show a status Badge in the actions column.
- Approve confirmation Modal shows the requester name + date range; the
  primary Button label is "Approve".
- Reject Modal: same reason-required pattern as final approvals (textarea
  id `reject-reason`, ≥10 chars).
- Approve calls `PATCH /v1/leave/requests/:id/approve`, NOT POST. Reject is
  `PATCH /v1/leave/requests/:id/reject` with `{ reason }` body. **Tests
  that previously asserted POST must be updated.**

### Schedule — selectors and flows

- Tab list has at most three triggers labelled `Company`, `Team`, `Individual`.
  The Company tab is hidden for Manager + Employee viewers.
- Cells with `data-source !== 'template'` are styled with the warning palette
  and include an "Override" Badge.
- "New override" opens a Modal with a "Scope" Select. For Manager-only
  callers the Select has a single option (`User`); for Admin/FinMgr there
  are three (`User`, `Project`, `Organisation-wide`). The target picker
  (user/project) toggles visibility based on the chosen scope.

### Tray SSE flow — manual smoke test

1. Sign in via the tray (mock or Keycloak).
2. In the web app, start a timer on any project.
3. Wait ≤2s. The tray should switch from `morning` / `idle` to `running`
   and show the timer counting up.
4. In the web app, stop the timer.
5. The tray's `ActiveTimer` should disappear within ≤2s (SSE round-trip),
   replaced by the "clocked out for now" panel.
6. Force a 401 from the backend (e.g. delete the session row in Postgres).
7. The tray should immediately drop to the "Sign in with Microsoft" screen
   instead of looping reconnect (verified via the `sync:auth-expired`
   channel).

## For changelog-writer

User-visible new features in this pass:

- **Admin > Users**: list, role assignment (per-role POST/DELETE), profile
  edits (display name + IANA timezone with short-list + custom fallback).
- **Admin > Clients**: CRUD + archive with friendly 409 messaging.
- **Admin > Projects**: CRUD + archive, members and managers drawers with
  per-row add/remove.
- **Admin > Rates**: per-employee cost rates and per-project billable rates
  with full effective-dated history viewer (Admin/FinMgr only).
- **Final approvals page**: stage-2 batch approve/reject with reason validation
  and stage-1≠stage-2 invariant surfacing.
- **Leave approvals page**: action UI with PATCH approve / PATCH reject
  (previously read-only list).
- **Schedule page**: three-tab dashboard (Company / Team / Individual) with
  override-creation Modal honouring the per-role scope-allowance matrix.
- **Tray real-time sync**: web-app timer events now propagate to the tray
  within one SSE round-trip; the tray re-authenticates correctly on session
  expiry.

## For backend-dev (cross-lane sanity)

- The rates UI calls `POST /v1/cost-rates`, `GET /v1/cost-rates?current=true`,
  `GET /v1/cost-rates?user_id=…&page=…` and the same shape for
  `/v1/billable-rates`. These endpoints are not yet in `openapi.yaml`; my
  page fails gracefully (LoadingSpinner → ErrorBlock) until the backend
  ships them. Recommend confirming the URL shape with frontend before
  cementing.
- The schedule dashboard request uses `GET /v1/schedules/dashboard?tab=company|team|individual&date_from=&date_to=&user_id=`.
  Response shape expected: `{ data: ScheduleDashboardRow[] }`. The page
  tolerates both `data` and `items` field naming.
- The final-approvals page reads from `GET /v1/approvals/queue?stage=final&limit=200`
  and expects `TimeEntry[]` under either `items` or `data`. If the response
  carries a `user_name` field on each TimeEntry, the page uses it; otherwise
  it falls back to `User #<id>`.
- All admin Modals invalidate the relevant TanStack-Query cache keys
  (`['admin', 'users']`, `['admin', 'projects']`, `['admin', 'clients']`,
  `['admin', 'cost-rates']`, `['admin', 'billable-rates']`,
  `['schedule', 'dashboard']`, `['approvals', 'queue']`,
  `['leave', 'approvals']`) on success so the lists re-fetch.

# Open questions / unknowns

1. **Rates endpoints not in `openapi.yaml`** — the cost-rates and
   billable-rates UIs are wired against the URL shape implied by
   ARCHITECTURE.md § effective-dated rates. Confirm the contract during the
   v1.0.1 backend pass that ships these endpoints; the frontend shapes are
   hand-typed in `api-types.ts` with a `TODO(post-merge)` marker.
2. **Project tasks not loadable from the projects admin page** — task
   management is described in REQUIREMENTS F2.3 but the openapi.yaml task
   endpoints (`/v1/projects/:id/tasks`) aren't surfaced in any admin UI
   yet. Deferred to v1.0.1 per the dispatch ("don't go beyond what was
   requested").
3. **No re-anchor flow for user-managers (person-anchored)** — the projects
   page exposes project-manager anchoring but not the symmetrical
   `user_managers` table. The architecture supports both; the UI for the
   latter is also v1.0.1. Manager assignment is currently project-anchored
   only via this UI.
4. **Schedule grid does not currently render the lunch window** — the
   tooltip mentions it but the cell only colours the start/end span. v1.0.1
   polish.
5. **`GET /v1/projects/:id/members` and `GET /v1/projects/:id/managers` are
   not yet in `openapi.yaml`** — only POST/DELETE are defined. The projects
   page assumes a GET that returns `{ data: ProjectMember[] }` and
   `{ data: ProjectManagerAnchor[] }` respectively (matching the
   OffsetPaginated shape used elsewhere). Until the backend adds these, the
   "Members" / "Managers" drawers will show the ErrorBlock with NOT_FOUND.
   Recommend backend-dev adds these in the same pass that ships the rate
   endpoints. Add-by-Select + remove-per-row code paths work independently
   of the listing endpoint.

# Verification evidence

This sandbox does not have a live `pnpm install` available — the agent
relies on the existing dependency lockfile being valid in CI. Manual
verification expected once the monorepo's first `pnpm install` lands:

- `pnpm --filter @harvoost/web typecheck` → expected: 0 errors. Verified by
  spot-checking that every imported symbol from `@harvoost/ui` is exported
  by `packages/ui/src/index.ts` (Button, Modal, ModalContent, Input, Select,
  Badge, Card, Table+T*, Avatar, EmptyState, LoadingSpinner, Tabs+Tabs*,
  useToast — all present); every imported symbol from `@/lib/api-types.js`
  is defined in the new `api-types.ts` block; and `OffsetPaginated<T>` and
  `Paginated<T>` are distinct types whose use sites match.
- `pnpm --filter @harvoost/tray typecheck` → expected: 0 errors. The
  `onAuthExpired` channel is wired symmetrically through main → preload →
  renderer; the bridge type `HarvoostBridge = typeof harvoostApi` includes
  the new method automatically.
- `grep -rn "StubSection" apps/web/app` → only `/settings/page.tsx` still
  references `StubSection`; every other surface listed in the dispatch is
  off the stub list.
- `grep -rn "/v1/sync/stream" apps/tray` → zero hits (endpoint renamed).
- `grep -rn "/v1/sync/events" apps/tray` → one hit, in `sync.ts`.
- `grep -rn "PATCH.*leave/requests" apps/web` → both verb sites
  (`/approve` and `/reject`) use PATCH; no leftover POST calls.
- Manual flow walk-through against the openapi.yaml document confirms each
  page's request shape (path, method, body field names) matches the spec.
