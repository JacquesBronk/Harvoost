# FEAT-001 — Start-timer / new-entry UI on /timesheets (GitHub #5)

- **GitHub issue:** [#5](https://github.com/JacquesBronk/Harvoost/issues/5)
- **Parent run:** 87edeba4-9a80-4a73-858b-548fd9026da4 (harvoost-timetracking, v0.1.0 complete)
- **Sub-run id:** 7d2e5ff6-dda8-4ef9-a44e-b901485446e8
- **Mode:** feature (directed flow, like the INC-002/3/4 hotfix flow — not full requirements interview)
- **Opened:** 2026-05-23T18:20:30Z

## Reporter description (verbatim)
> FEATURE mode on the existing system. This becomes FEAT-001 under run
> 87edeba4-9a80-4a73-858b-548fd9026da4. Run it directed (like the INC-002/3/4
> hotfix flow): the issue is clear, so go brainstorm/design → HITL → build →
> test → HITL → push.
>
> THE FEATURE (issue #5): /timesheets has no UI to start a timer or create a
> time entry, so core clock-in (REQUIREMENTS F1/F2) is unreachable from the web
> app. TimerBar can only STOP; when nothing is running it shows the dead text
> "Start one from timesheets" (apps/web/src/components/TimerBar.tsx ~line 82),
> but apps/web/app/timesheets/page.tsx has no start/create control. The only
> wired calls are GET /v1/time-entries, GET /v1/time-entries/running, and
> POST /v1/time-entries/stop.
>
> BACKEND IS READY — purely frontend wiring of existing endpoints:
> apps/api/src/time-entries/time-entries.controller.ts already exposes
> @Post('start'), @Post('switch'), @Post() (manual create), @Get(),
> @Get('running'), @Patch(':id'), @Delete(':id'), @Post('stop'). Mutating
> routes require an Idempotency-Key header (IdempotencyService) — wire it.
>
> WHAT TO BUILD:
>   - A "Start timer" control (project picker → POST /v1/time-entries/start with
>     Idempotency-Key). Put it on /timesheets AND replace TimerBar's dead "Start
>     one from timesheets" text with a real start affordance.
>   - A "New entry" action for manual entries (POST /v1/time-entries: project +
>     start/end). Show it in the week list after create.
>   - Wire "switch" (POST /v1/time-entries/switch) to change the active project
>     without stopping.
>   - The project picker can use GET /v1/projects (the BigInt 500 on that list
>     was fixed in INC-004, so it now returns 200).
>
> DESIGN DECISION TO SURFACE AT THE UX GATE (gate a): task selection. Starting a
> timer may want a project AND a task, but the project-tasks endpoints
> (GET/POST /v1/projects/{id}/tasks) are STUBBED/unimplemented (allowlisted as a
> KNOWN gap in the contract test). Options: (i) ship project-only start now and
> defer tasks, or (ii) also implement the tasks endpoints (backend scope creep).
> Recommend (i) unless told otherwise. Also surface start-control placement
> (inline on /timesheets vs a TimerBar dropdown vs both) with a quick mock.
>
> SCOPE GUARDRAILS: Do NOT touch the real-Entra-in-prod OIDC path (fail-closed,
> v0.2.0). Do NOT touch .github/ (still needs the `workflow` OAuth scope; leave
> untracked, as in INC-001/2/3/4). Do NOT regress INC-001/002/003/INC-004
> (CSP nonce, login round-trip, /me throttle+loop, endpoint reconciliation +
> contract test). Stay scoped to #5 — the separate latent "Submit week" 404
> (POST /v1/time-entries/{id}/submit, a KNOWN_ROUTE_GAP from INC-004) is NOT
> part of #5; flag it but don't fix it unless approved.
>
> VERIFY: pnpm test must stay green (baseline 610 pass + 1 known pre-existing
> RbacScopeService failure) and @harvoost/contract must stay green (122/122 —
> any new apiFetch path must map to a real route + spec op). Add a frontend test
> for the start/create wiring. Confirm via Playwright (tests/e2e, chromium-live,
> E2E_LIVE=1 E2E_SKIP_WEB_SERVER=1) against the running stack: sign in as
> alice@harvoost.local / dev-alice-pass, start a timer from /timesheets, assert
> it appears in GET /v1/time-entries/running and in TimerBar; create a manual
> entry and see it in the week list; stop the timer. Then docker compose up -d
> --build to confirm clean.
>
> DOCUMENT: append an Added entry to CHANGELOG.md under [Unreleased] referencing
> #5 (new capability, not a Fixed bug).
>
> HITL GATES: pause for approval (a) after the UX/design pass, before building,
> and (b) before pushing the commit. Don't auto-push. Commit + push to main
> (closes #5) only after gate (b). The dev stack is running.

## HITL gates
- **(a)** After the UX/design pass (FEATURE_PLAN + placement mock + task-selection recommendation), before dispatching the build.
- **(b)** Before pushing the commit. Commit + push to main (closes #5) only after gate (b).
