---
phase: features/FEAT-001 (design pass)
agent: product-analyst
started: 2026-05-23
finished: 2026-05-23
status: complete — awaiting HITL gate (a)
---

# Summary
Grounded GitHub #5 (start-timer / new-entry UI on /timesheets) against the live code. Verdict:
this is a **frontend-only wiring task** — no structural change, no API change. All three target
operations (`POST /v1/time-entries/start`, `/switch`, `POST /v1/time-entries` manual create) are
already declared in the pinned `openapi.yaml` AND backed by registered NestJS routes, so the
`@harvoost/contract` suite stays 122/122 with no api-designer step. Produced `FEATURE_PLAN.md`
(scope assessment + 5 user stories with test-writable Given/When/Then) and `UX_DESIGN.md` (the
gate-(a) decision doc with ASCII mocks). Two decisions need the user's pick at gate (a): task
selection and start-control placement.

# Files touched (this design pass)
- `.hacktogether/runs/87edeba4-9a80-4a73-858b-548fd9026da4/features/FEAT-001/FEATURE_PLAN.md` (new)
- `.hacktogether/runs/87edeba4-9a80-4a73-858b-548fd9026da4/features/FEAT-001/UX_DESIGN.md` (new)
- `.hacktogether/runs/87edeba4-9a80-4a73-858b-548fd9026da4/features/FEAT-001/HANDOFF.md` (new)
(No application source modified.)

# Open decisions for gate (a) — with recommendations
1. **Task selection:** RECOMMEND **(i) project-only start** now; defer tasks until
   `GET/POST /v1/projects/{id}/tasks` are real. `task_id` is optional on all controller schemas,
   so adding tasks later is non-breaking. Alternative (ii) implements the tasks endpoints =
   backend scope creep.
2. **Start-control placement:** RECOMMEND **(C) both** — inline control on /timesheets + a real
   start affordance replacing TimerBar's dead text. It is the literal ask in #5 and is cheap
   because a single `useStartTimer` hook backs both render sites. Fallback if minimal change is
   preferred: (A) inline-only (bar just drops the dead link).

# What downstream agents need to know (record in the run Decision log)
- **Scope verdict:** structural change = NO; API change = NO (pure FE wiring). Build chain does
  NOT need `/hacktogether_architecture` or `/hacktogether_api_design`.
- **TRAP 1 — `switch` field-name drift (build to the controller, not the spec).** `openapi.yaml`
  `SwitchTimeEntryRequest` uses `new_project_id`/`new_task_id`/`new_notes` and response
  `{ stopped, started }` (openapi.yaml:3394-3408), but the **live controller** validates
  `project_id`/`task_id`/`notes` (`SwitchSchema`, time-entries.controller.ts:34) and returns a
  single entry. The FE MUST send `project_id`. Contract test only checks query keys, so it stays
  green either way — Playwright (live) is the real guard.
- **TRAP 2 — `running` response envelope (must reconcile or the feature visibly fails).**
  `GET /v1/time-entries/running` returns `{ data: null | <entry> }` (controller:148), but the FE
  type `RunningTimerSnapshot` + `TimerBar` read `.running` / `.today_total_hours`
  (TimerBar.tsx:33,108). Against the live backend `data.running` is always undefined — a
  started timer would NOT appear in TimerBar today. The build MUST fix the FE running-read to the
  `{ data }` envelope as part of this feature. `today_total_hours` is not returned live — derive
  from the week list or drop it; do not block start on it.
- **TRAP 3 — `start`/`switch` return the entry UNWRAPPED** (controller:198,277), unlike
  `list`/`running` which wrap in `{ data }`. Don't assume a wrapper on the mutation responses.
- **TRAP 4 — manual create takes NO Idempotency-Key** (controller:300-335). Only start/stop/switch
  require it. The proven attach pattern is TimerBar's stop call (TimerBar.tsx:50-55) via
  `newIdempotencyKey()` (api-client.ts:168).
- **Project picker source:** `GET /v1/projects` returns `{ data, page, page_size }`
  (projects.controller.ts:30-48); read `data[]`, ids are strings (INC-004 BigInt fix). No
  `total_count` on this list.
- **Out of scope / do not touch:** task endpoints; the "Submit week" 404
  (`POST /v1/time-entries/{id}/submit`, KNOWN_ROUTE_GAP, contract-spec.ts:125); the
  `start_at_from`/`start_at_to` list-param drift (allowlisted, contract-spec.ts:95); SSE; the
  real-Entra OIDC path; `.github/`. Do not regress INC-001/002/003/004.
- **Optional follow-up flagged (not in FEAT-001):** reconcile the `switch` spec schema to the
  controller (`new_project_id` → `project_id`, `{ stopped, started }` → single entry). An
  api-designer task if the orchestrator wants spec/runtime parity.

# Likely build-lane file list
- `apps/web/src/components/TimerBar.tsx` (modify — replace dead text, fix running-read, add Switch)
- `apps/web/app/timesheets/page.tsx` (modify — inline Start + New entry)
- `apps/web/src/lib/api-types.ts` (modify — fix RunningTimerSnapshot envelope; add request types)
- `apps/web/src/lib/time-entries.ts` (new — startTimer/switchTimer/createManualEntry + hooks)
- `apps/web/src/components/StartTimerControl.tsx` (new — picker + Start, shared)
- `apps/web/src/components/NewEntryForm.tsx` (new — manual-create form/modal)
- `apps/web/__tests__/feat001-timer-wiring.test.ts` (new — pins URL/method/body/Idempotency-Key,
  mirrors inc004-*-query.test.ts mocked-fetch convention)
- `CHANGELOG.md` (modify — Added entry under [Unreleased] referencing #5; line 8 is the heading)
(Final component boundaries are the builder's call; no new package/app.)

# Verification plan (for the test lane)
- `pnpm test` stays green: baseline 610 pass + 1 known pre-existing RbacScopeService failure.
- `@harvoost/contract` stays 122/122 (no new param drift; all three POST paths already map to
  spec ops + routes).
- New FE unit test asserts: start → `POST /v1/time-entries/start` + `Idempotency-Key` + body
  `{ project_id }`; switch → `POST /v1/time-entries/switch` + key + `{ project_id }`; manual →
  `POST /v1/time-entries` + body `{ project_id, start_at, end_at }` + NO key; running-read parses
  `{ data }`.
- Playwright `chromium-live` (E2E_LIVE=1 E2E_SKIP_WEB_SERVER=1) as alice@harvoost.local /
  dev-alice-pass: start a timer from /timesheets → assert it appears in GET /running + TimerBar;
  create a manual entry → see it in the week list; switch project → bar shows new project, status
  stays running; stop → bar idles. Then `docker compose up -d --build` clean.

# Open questions / unknowns
- Gate (a) picks for §1 (task selection) and §2 (placement) — recommendations stated above.
- `[ASSUMED: future-dated manual entries allowed]` (controller does not reject them) — confirm or
  override at gate (a).
- `[ASSUMED: when a timer is already running, the start control surfaces Switch rather than firing
  a start that 409s]` — confirm at gate (a).
