---
phase: 04-build/frontend
agent: frontend-dev
started: 2026-05-23
finished: 2026-05-23
status: complete
---

# Summary
Wired the start-timer / new-entry / switch UI on the Harvoost web app (FEAT-001 / GitHub #5)
per the gate (a) pinned contract. All clock-in mutation logic now lives in ONE shared lib
(`apps/web/src/lib/time-entries.ts`) so the "both placements" decision (Option C) is a single
code path rendered in three render sites: an inline "Start a timer" card on `/timesheets`, a
real Start affordance in the idle `TimerBar` (replacing the dead "Start one from timesheets"
text), and a "Switch" affordance on the running `TimerBar`. Added an optional project-task
picker (`GET /v1/projects/{project_id}/tasks`) and a notes textarea on start/switch/manual,
and a manual "New entry" modal with client-side validation. Reconciled the two known
controller/spec divergences: the `running` read now consumes the `{ data }` envelope (so a
started timer surfaces in the bar), and `switch` sends `project_id` (not the spec's
`new_project_id`). Stayed entirely inside `apps/web`; did not touch `apps/api`, `packages/`,
`useCurrentUser`, the CSP middleware, or the login round-trip.

# Files touched
- apps/web/src/lib/time-entries.ts (new) — shared lib: `startTimer`, `switchTimer`,
  `createManualEntry`, `fetchRunning`, `fetchProjectsForPicker`, `fetchProjectTasks`,
  `validateManualEntry`, `MAX_ENTRY_HOURS`.
- apps/web/src/lib/api-types.ts (modified) — fixed `RunningTimerSnapshot` to the `{ data }`
  envelope; added `StartTimerRequest`, `SwitchTimerRequest`, `CreateManualEntryRequest`.
- apps/web/src/components/StartTimerControl.tsx (new) — project picker (required) + task picker
  (optional) + notes textarea + Start/Switch; reused inline, in the idle bar, and on the running
  bar in `mode="switch"`.
- apps/web/src/components/NewEntryForm.tsx (new) — manual-entry modal (project + optional task +
  start/end datetime + notes) with client validation and `datetime-local`→ISO(+offset) conversion.
- apps/web/src/components/TimerBar.tsx (modified) — running read → `data.data`; idle Start
  affordance; running "Switch" affordance; dropped the dead link and the `today_total_hours`
  line (not returned by the live endpoint).
- apps/web/app/timesheets/page.tsx (modified) — inline Start card + "New entry" button/modal.
- apps/web/__tests__/feat001-timer-wiring.test.ts (new) — 18 tests pinning the contract.

# Components / hooks introduced
- `StartTimerControl` (component) — props `{ mode: 'start' | 'switch', layout: 'inline' |
  'compact', onDone? }`. Backs all three start/switch render sites. Uses TanStack Query for
  projects + per-project tasks; one `useMutation` that calls `startTimer` or `switchTimer`.
- `NewEntryForm` (component) — props `{ open, onOpenChange, zone }`. Modal over the shared lib.
- No custom hooks — the shared logic is plain functions in `time-entries.ts`, which keeps them
  directly unit-testable in the node-env vitest setup (matching the INC-004 convention).

# What downstream agents need to know
- **Running-envelope reconciliation:** `RunningTimerSnapshot` is now `{ data: TimeEntry | null }`.
  `TimerBar` reads `data?.data ?? null` (was `data?.running`). `fetchRunning()` returns the raw
  envelope. The only consumers of this type are `TimerBar.tsx` and `time-entries.ts` (verified by
  grep); both updated. `today_total_hours` was dropped from the bar (not returned live; per
  pinned contract, do not block start on it).
- **Switch field reconciliation:** `switchTimer` posts `{ project_id, task_id?, notes? }` — the
  live controller field. A test asserts the body has `project_id` and NOT `new_project_id`.
- **Already-running behavior (gate (a) #4):** the running bar surfaces a "Switch" affordance
  (atomic re-point via `POST /switch`) rather than a Start that would 409. The idle Start
  affordance is only shown when nothing is running.
- **Task picker is optional and depends on the parallel backend lane:** the FE calls
  `GET /v1/projects/{project_id}/tasks?is_active=true` and renders `data[]`; an empty list is a
  valid "No tasks" state (the Select is disabled, but start/create still proceeds project-only).
  ids are treated as STRINGS. Until the backend route ships, that GET 404s and the picker shows
  "No tasks" gracefully (the task query error does not block start — only the projects query
  gating matters). End-to-end (chromium-live) needs the backend lane's route registered.
- **New apiFetch paths introduced (all map to a spec op + soon-real route):**
  `POST /v1/time-entries/start`, `POST /v1/time-entries/switch`, `POST /v1/time-entries`,
  `GET /v1/time-entries/running`, `GET /v1/projects`, `GET /v1/projects/{project_id}/tasks`.
  No other new path. `/submit` and the `start_at_from`/`start_at_to` list params were left
  untouched (pre-existing / allowlisted / out of scope).
- **No new dependencies.** The idle/switch disclosure panels use a `useState` toggle with ARIA
  (`aria-expanded`/`aria-controls`) rather than introducing `@radix-ui/react-popover` into
  `apps/web` (it is a `@harvoost/ui` dep but not re-exported and not an `apps/web` dep). The
  notes field is a semantic native `<textarea>` with a real `<label>` (no Textarea exists in the
  UI lib; I did not add one to `packages/`).
- **Decision worth logging:** dropped the `today_total_hours` display from `TimerBar` because the
  live `/running` endpoint does not return it (pinned contract). If a "today total" is wanted
  later, compute it from the week list — out of scope here.

# Open questions / unknowns
- None blocking. The task-picker rendering depends on the parallel backend-dev lane registering
  `GET /v1/projects/{project_id}/tasks`; until then the picker degrades to "No tasks" and start
  still works. The orchestrator's chromium-live + @harvoost/contract run will confirm the route.

# Verification evidence
- `pnpm --filter @harvoost/web test` → 7 files / 75 tests passed (baseline 57 + 18 new
  `feat001-timer-wiring`). No regressions.
- `pnpm --filter @harvoost/web typecheck` (`tsc --noEmit`) → clean, no errors.
- apiFetch path audit (grep over changed/new files) → only the 6 allowlisted paths above.
- NOTE: `pnpm --filter @harvoost/web lint` fails at startup with an ESLint-options error
  (`Unknown options: useEslintrc, extensions, …`) — a PRE-EXISTING `next lint`/ESLint version
  mismatch unrelated to this change (it errors before touching any file). typecheck is the
  authoritative gate and is clean.
- Did NOT run docker rebuild, the contract test, or Playwright (orchestrator owns end-to-end
  verify) per instructions.
