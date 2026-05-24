# Feature FEAT-001 — Start-timer / new-entry UI on /timesheets (GitHub #5)

## Reporter description (verbatim)
> /timesheets has no UI to start a timer or create a time entry, so core clock-in
> (REQUIREMENTS F1/F2) is unreachable from the web app. TimerBar can only STOP;
> when nothing is running it shows the dead text "Start one from timesheets"
> (apps/web/src/components/TimerBar.tsx ~line 82), but apps/web/app/timesheets/page.tsx
> has no start/create control. BACKEND IS READY — purely frontend wiring of existing
> endpoints. WHAT TO BUILD: (1) a "Start timer" control (project picker → POST
> /v1/time-entries/start with Idempotency-Key) on /timesheets AND replacing TimerBar's
> dead text; (2) a "New entry" manual-create action (POST /v1/time-entries: project +
> start/end); (3) wire "switch" (POST /v1/time-entries/switch) to change the active
> project without stopping. The project picker can use GET /v1/projects (200 since INC-004).
> Recommend project-only start, defer task selection (project-tasks endpoints are STUBBED).

## Light intake summary
The Harvoost web app can observe and stop a timer but cannot start one or create a manual
entry — core clock-in (REQUIREMENTS F1/F2) is unreachable from the browser. The backend
already exposes every route needed (`@Post('start')`, `@Post('switch')`, `@Post()` manual
create, plus the existing `@Get()`, `@Get('running')`, `@Post('stop')` in
`apps/api/src/time-entries/time-entries.controller.ts:151-335`), and all three target
operations are already declared in the pinned `openapi.yaml`. This is therefore a
**frontend-only wiring task**: surface a project picker + "Start timer" affordance on
`/timesheets` and in `TimerBar`, add a "New entry" manual-create form, and wire "switch"
to re-point the running timer's project without stopping.

The one decision that must reach the user at gate (a) is **task selection**: starting a
timer can semantically take a project AND a task, but the project-tasks endpoints
(`GET/POST /v1/projects/{id}/tasks`) are stubbed/allowlisted with no real implementation.
We recommend shipping **project-only** now and deferring tasks to a follow-up (see
`UX_DESIGN.md` § 1). The second open decision is **start-control placement** (inline /
TimerBar dropdown / both) — the issue literally asks for "both" (see `UX_DESIGN.md` § 2).

## Analysis (think-before-act)

1. **What is the user actually trying to accomplish?** Make clock-in reachable from the
   web app. Today an employee who lands on `/timesheets` with no timer running sees a dead
   "Start one from timesheets" link in `TimerBar` (`TimerBar.tsx:78-83`) that points back to a
   page with no start control — a dead end. The core need is: pick a project, press start,
   see the running timer; optionally log time after the fact (manual entry); optionally
   change projects mid-stream (switch) without losing elapsed time.

2. **What already exists?** Backend: every route exists and is battle-tested (transactional
   stop+start, idempotency dedupe, RBAC scoping, overlap guard). Frontend: the read side is
   wired — `TimerBar` polls `GET /v1/time-entries/running` and calls `POST /stop` with an
   `Idempotency-Key` (`TimerBar.tsx:50-55`); `/timesheets` lists `GET /v1/time-entries` for the
   week. The idempotency-key helper (`newIdempotencyKey()`, `api-client.ts:168`) and the
   header-attach pattern already exist and are proven. The project picker has a known-good
   data source: `GET /v1/projects` returns `{ data, page, page_size }` (`projects.controller.ts:30-48`).

3. **Am I adding unnecessary scope?** Tasks are the temptation. Implementing real project-tasks
   endpoints would turn a FE-wiring change into a backend feature (new controllers, DTOs, spec
   ops, migrations, tests) — out of proportion to "make clock-in reachable". Recommend
   project-only start. Likewise the "Submit week" 404 is a separate latent gap and stays out.

4. **Most likely ways an implementor misreads this** (call these out loudly — they are real traps):
   - **Spec vs. live controller field-name drift on `switch`.** `openapi.yaml`'s
     `SwitchTimeEntryRequest` uses `new_project_id`/`new_task_id`/`new_notes` and
     `SwitchTimeEntryResponse` is `{ stopped, started }` (openapi.yaml:3394-3408). The **running
     controller** validates `project_id`/`task_id`/`notes` (`SwitchSchema`,
     `time-entries.controller.ts:34-38`) and returns a **single** normalized entry, not
     `{ stopped, started }`. The contract test only checks query keys (not body keys) for these
     ops, so it stays green either way — but the FE MUST send what the **controller** expects
     (`project_id`) or the request 422s live. Build to the controller; Playwright will catch a wrong guess.
   - **Response-envelope drift on `running`.** `GET /v1/time-entries/running` returns
     `{ data: null }` or `{ data: <entry> }` (`time-entries.controller.ts:148`). But the FE type
     `RunningTimerSnapshot` expects `{ running, today_total_hours, server_time }` and `TimerBar`
     reads `data?.running` / `data?.today_total_hours` (`TimerBar.tsx:33,108`). Against the live
     backend, `data.running` is always `undefined` — so a successfully-started timer would NOT
     appear in TimerBar today. The build lane MUST reconcile the FE running-read to the `{ data }`
     envelope (read `data.data`) as part of this feature, or the headline acceptance criterion
     ("started timer appears in TimerBar") fails. Note: `today_total_hours` is not returned by the
     live endpoint — render it from the week list or drop it; do not block start on it.
   - **`start` returns the entry directly, not wrapped.** `start`/`stop`/`switch` return
     `normalizeRow(...)` directly (no `{ data }` wrapper) (`time-entries.controller.ts:198,225,277`),
     whereas `list`/`running` DO wrap in `{ data }`. The mutation handlers should not assume a
     wrapper on the start/switch response.
   - **Manual create does NOT take an Idempotency-Key.** `@Post()` createManual has no
     `Idempotency-Key` header and no idempotency check (`time-entries.controller.ts:300-335`). Only
     start/stop/switch require the header. Do not attach (or require) the header on manual create.
   - **List query-param drift is pre-existing and allowlisted.** `/timesheets` sends
     `start_at_from`/`start_at_to` (`timesheets/page.tsx:43-44`); the controller's `ListQuery`
     uses `date_from`/`date_to` (`time-entries.controller.ts:64-71`) and silently drops the unknown
     params. This is on the contract `KNOWN_PARAM_DRIFT` allowlist (`contract-spec.ts:95`) and is
     OUT OF SCOPE for #5 — do not "fix" it, do not regress it. The list still returns the week's
     entries because RBAC self-scope covers the requester; the date filter is just not applied.

## Scope assessment

- **Structural change required:** **no.**
  - No new app/package, no build-graph change. New work lands inside the existing `apps/web`
    workspace (a couple of components + a FE lib module + a test). No `/hacktogether_architecture`
    re-run needed.

- **API change required:** **no** (pure FE wiring).
  - All three target operations are already declared in the pinned `openapi.yaml` AND backed by
    registered NestJS routes:
    - `POST /v1/time-entries/start` — spec openapi.yaml:1087; route time-entries.controller.ts:151.
    - `POST /v1/time-entries/switch` — spec openapi.yaml:1177; route time-entries.controller.ts:235.
    - `POST /v1/time-entries` (manual create) — spec openapi.yaml:1010; route time-entries.controller.ts:300.
    - `GET /v1/projects` (picker source) — spec present; route projects.controller.ts:30; 200 since INC-004.
  - Because every new `apiFetch` path the build introduces maps to an existing spec op + real
    route, the **@harvoost/contract** suite stays green with no api-designer involvement. The
    build chain does **not** need a `/hacktogether_api_design` step.
  - **Caveat (not an API change, but flag for the build lane):** the spec's request/response
    schemas for `switch` (`new_project_id`, `{ stopped, started }`) diverge from the live
    controller (`project_id`, single entry). The FE must follow the **controller**. We are NOT
    proposing to change the spec to match (that would be an API-spec edit and widen scope); we
    are recording the divergence so the build lane wires the correct field names. If the
    orchestrator wants the spec reconciled to the controller, that is a separate, optional
    api-designer follow-up — out of FEAT-001's "FE wiring" scope.

- **Affected modules (modified):**
  - `apps/web/src/components/TimerBar.tsx` — replace dead "Start one from timesheets" text with a
    real start affordance; reconcile the running-read to the `{ data }` envelope; add a "Switch
    project" affordance on the running bar.
  - `apps/web/app/timesheets/page.tsx` — add the inline "Start timer" control + "New entry" action.
  - `apps/web/src/lib/api-types.ts` — fix `RunningTimerSnapshot` to the `{ data }` envelope; add
    request types for start/switch/manual-create as needed.

- **New modules (added):**
  - `apps/web/src/lib/time-entries.ts` — a small FE lib exposing `startTimer`, `switchTimer`,
    `createManualEntry`, `fetchRunning`, and a `useProjectsForPicker` hook (or `useStartTimer` /
    `useSwitchTimer` / `useCreateEntry` mutation hooks). Centralising the mutation + idempotency-key
    wiring means the inline control and the TimerBar affordance share one code path (so "both"
    placements are not double the work).
  - `apps/web/src/components/StartTimerControl.tsx` — project picker + Start button (used inline
    on /timesheets and inside the TimerBar idle state).
  - `apps/web/src/components/NewEntryForm.tsx` (or a modal) — project + start/end + optional notes.
  - `apps/web/__tests__/feat001-timer-wiring.test.ts` — pins the start/switch/manual-create
    `apiFetch` URL + method + body + Idempotency-Key presence, mirroring the
    `inc004-*-query.test.ts` mocked-fetch convention (`apps/web/__tests__/inc004-reports-query.test.ts`).

  (Exact component/file boundaries are the architect's/builder's call; the above is the expected
  shape. No new package, no new app.)

## Acceptance criteria (Given / When / Then — all test-writable)

### Story 1 — Start a timer from /timesheets (project-only)
- **Given** an authenticated employee on `/timesheets` with no running timer,
  **when** they open the project picker, **then** the picker lists the active projects from
  `GET /v1/projects` (reading `data[]`, each with `id` as a string + `name`).
- **Given** a project is selected, **when** they press "Start", **then** the FE sends
  `POST /v1/time-entries/start` with header `Idempotency-Key: <crypto.randomUUID()>` and body
  `{ project_id: <selected id> }` (no `task_id`).
- **Given** the start returns 201 with the new entry, **then** the running-timer query is
  invalidated and within one poll cycle (≤10s) `GET /v1/time-entries/running` returns the new
  entry under `data` and `TimerBar` renders the "Running" badge with the project name and a
  ticking elapsed counter.
- **Given** a project is already running, **when** the user presses Start for a different
  project, **then** the API returns 409 and the FE shows the toast "Another timer is already
  running" and offers Switch instead of silently failing. `[ASSUMED: when a timer is already
  running the start control is replaced by/redirects to the Switch affordance rather than firing
  a start that 409s — recommended in UX_DESIGN §2/§4; confirm at gate (a).]`

### Story 2 — Start a timer from the (idle) TimerBar
- **Given** no running timer, **when** the user views any page with the global `TimerBar`,
  **then** the dead "Start one from timesheets" link is gone and a real start affordance is
  present (per the placement chosen at gate (a)).
- **Given** the user starts from the TimerBar affordance, **then** it calls the SAME
  `startTimer` lib path as the /timesheets control (same `POST /v1/time-entries/start` +
  Idempotency-Key), and the bar transitions to the running state on success.

### Story 3 — Create a manual entry
- **Given** an employee on `/timesheets`, **when** they open "New entry", **then** a form
  appears with: project (required, from `GET /v1/projects`), start datetime (required), end
  datetime (required), notes (optional).
- **Given** the form is submitted, **when** end ≤ start, **then** the FE blocks submit and shows
  a field-level "End must be after start" without calling the API.
- **Given** a valid form (end > start, duration ≤ 24h), **when** submitted, **then** the FE sends
  `POST /v1/time-entries` (NO Idempotency-Key) with body
  `{ project_id, start_at, end_at, notes? }` as ISO-8601 with offset.
- **Given** the create returns 201, **then** the time-entries query is invalidated and the new
  entry appears in the week list for the week containing its `start_at` (with status `draft`).
- **Given** the API returns 409 (overlap) or 422 (validation), **then** the FE surfaces the
  error envelope's message via the existing toast/`describeError` path and does NOT clear the form.

### Story 4 — Switch the active project without stopping
- **Given** a timer is running, **when** the user invokes "Switch project" and picks a different
  project, **then** the FE sends `POST /v1/time-entries/switch` with header
  `Idempotency-Key: <crypto.randomUUID()>` and body `{ project_id: <new id> }` (controller field
  name — NOT `new_project_id`).
- **Given** the switch returns 200, **then** the running-timer query is invalidated and within
  one poll cycle `GET /v1/time-entries/running` reflects the NEW project while the timer remains
  in `running` status (no Stop in between); the previous entry is closed to `draft` server-side.

### Story 5 — Stop still works (regression guard)
- **Given** a running timer, **when** the user presses Stop in `TimerBar`, **then** the existing
  `POST /v1/time-entries/stop` (with Idempotency-Key) behaviour is unchanged and the bar returns
  to the idle (now start-capable) state.

### Cross-cutting
- **Given** any mutating call (start/switch/stop), **then** exactly one `Idempotency-Key` header
  is attached per submit, generated by `newIdempotencyKey()` / `crypto.randomUUID()`
  (`api-client.ts:168`). Manual create attaches NONE.
- **Given** the full FE change, **when** `pnpm test` runs, **then** it stays green (baseline 610
  pass + 1 known pre-existing `RbacScopeService` failure) AND `@harvoost/contract` stays 122/122
  (every new `apiFetch` path maps to an existing spec op + real route).
- **Given** the live stack, **when** the Playwright `chromium-live` flow signs in as
  `alice@harvoost.local`, starts a timer from /timesheets, creates a manual entry, switches, and
  stops, **then** each step is reflected in `GET /v1/time-entries/running` and the week list as
  specified above.

## Gate (a) decisions — APPROVED 2026-05-23 (PINNED CONTRACT for build lanes)

The UX gate expanded scope beyond pure FE wiring. These decisions override the recommendations above where they differ:

1. **Task field = OPTIONAL, pick-existing + notes.** A timer/entry may be associated with a task belonging to the project, plus a free-text notes field.
   - **Task picker is OPTIONAL** — start/create works on a project with no tasks; `task_id` is omitted when none chosen (`task_id` is optional on every controller schema).
   - **Notes** = the existing `notes` field (max 2000), shown as a textarea on start, switch, and manual create.
   - **NEW BACKEND LANE:** implement `GET /v1/projects/{project_id}/tasks` (read-only). It is already in the spec (`openapi.yaml:856`, `operationId: listProjectTasks`) but **no controller implements it (404 today)**. The FE task picker calls it, so the contract test REQUIRES a registered route (it asserts every FE `apiFetch` path maps to BOTH a declared spec op AND a registered NestJS route — see `tests/contract/src/contract.test.ts`). **PINNED contract:**
     - Path: `GET /v1/projects/{project_id}/tasks`, optional query `is_active` (boolean, declared in spec).
     - Response: `{ data: ProjectTask[] }`, `ProjectTask = { id, project_id, name, is_billable, is_active }` (`openapi.yaml:3282`). **String()-map every bigint id** (id, project_id) like the other list endpoints — INC-004's `BigInt.prototype.toJSON` makes ids serialize as strings; FE types must treat ids as `string`.
     - RBAC: project-visibility scoped (mirror the existing `projects.controller.ts` GET scoping; reuse `RbacScopeService`). 401/403/404 per spec.
     - Read-only ONLY. `POST`/`PATCH` tasks stay **unimplemented** (still spec'd) — out of scope; do NOT build them.
   - api-designer NOT needed (the GET op + ProjectTask schema already exist in the pinned spec). The backend lane aligns its response to the existing schema.

2. **Placement = BOTH (Option C).** Inline "Start a timer" control on `/timesheets` AND a real start affordance in `TimerBar` replacing the dead "Start one from timesheets" text. One shared `startTimer` lib fn / hook backs both render sites.

3. **Date rules = keep current behavior.** Free back-dating AND future-dating for manual entries; the existing no-overlap guard is the only protection (already blocks colliding with an approved entry). No new week/period approval-lock in FEAT-001. **A separate GitHub issue ([#6](https://github.com/JacquesBronk/Harvoost/issues/6)) tracks the period-locking feature** — do NOT build it here.

4. **Already-running behavior = offer Switch, not a raw 409.** When a timer is running and the user picks Start on a different project, surface the **Switch** action (atomic re-point, keeps elapsed time) instead of firing a Start that 409s. Switch body field is `project_id` (controller field name — NOT `new_project_id`), with `Idempotency-Key`.

**Net build shape:** TWO parallel lanes (disjoint file trees → no ownership conflict), anchored on this plan:
- **backend-dev** (apps/api): implement `GET /v1/projects/{project_id}/tasks` (read-only, RBAC-scoped, string ids) + unit/integration tests. NO migration (table + seed exist). Does NOT touch time-entries controller (already correct).
- **frontend-dev** (apps/web): all the UI wiring per Stories 1–5 below + the task picker (optional) + notes textarea + the running-envelope/`switch`-field reconciliations + FE tests.

## Out of scope (explicitly deferred)
- **(SUPERSEDED at gate (a))** ~~Task selection deferred~~ → Task selection is now IN SCOPE as an
  OPTIONAL picker backed by a newly-implemented read-only `GET /v1/projects/{project_id}/tasks`
  (see Gate (a) decision #1). Still **out of scope:** `POST`/`PATCH /v1/projects/{id}/tasks`
  (create/update tasks) — they stay spec'd-but-unimplemented; tasks are pick-existing only.
- **Period / timesheet approval locking** (block back-dating into an approved period) — deferred to
  GitHub issue [#6](https://github.com/JacquesBronk/Harvoost/issues/6) per gate (a) decision #3.
- **"Submit week" 404.** `POST /v1/time-entries/{id}/submit` is a KNOWN_ROUTE_GAP
  (`contract-spec.ts:125-131`) — a separate latent gap, flagged, NOT fixed here.
- **Reconciling the `switch` spec schema to the live controller** (`new_project_id` →
  `project_id`, `{ stopped, started }` → single entry). Flagged for an optional api-designer
  follow-up; the FE wires to the controller in the meantime.
- **The `start_at_from`/`start_at_to` list-param drift** — pre-existing, allowlisted, untouched.
- **SSE / `/v1/sync/stream` real-time updates** — the existing 10s poll is retained
  (`TimerBar.tsx:18`). No change.
- **`PATCH`/`DELETE` time-entry editing UI** — not requested by #5.
- Anything touching the real-Entra-in-prod OIDC path, `.github/`, or that would regress
  INC-001 (CSP nonce), INC-002 (login round-trip), INC-003 (/me throttle+loop), or INC-004
  (endpoint reconciliation + contract test).
