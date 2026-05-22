# Phase: test

Subagents: `tester` and `e2e-tester` (dispatched sequentially in this version; can run in parallel post-3.4 if Task 0.1 confirmed concurrent dispatch).
Phase folder: `.hacktogether/runs/<run_id>/05-test/`
Inputs: build HANDOFFs, codebase under `src/`, existing tests under `tests/`
Outputs: `05-test/TEST_REPORT.md`, `05-test/HANDOFF.md`

## Pre-dispatch

Update RUN_STATE.md: row #5 (test) → `▶ running`.

## Dispatch prompt — tester

> You are the `tester` agent. Run `<run_id>`.
> Phase folder: `.hacktogether/runs/<run_id>/05-test/`.
> Required context:
> - RUN_STATE.md, REQUIREMENTS.md, STACK.md
> - `04-build/*/HANDOFF.md` (read all)
> - Existing tests under `tests/`
>
> Verify unit/integration test coverage matches the acceptance criteria in REQUIREMENTS.md. Add missing tests. Run the full suite and capture pass/fail counts.
>
> Append your section to `05-test/TEST_REPORT.md` (create the file if needed) under a heading "## Unit & Integration".
>
> Write `05-test/HANDOFF.md` (overwrite if e2e-tester also writes — last writer aggregates).
>
> Exit.

## Dispatch prompt — e2e-tester

> You are the `e2e-tester` agent. Run `<run_id>`.
> [Same context as above.]
>
> Write end-to-end tests that exercise the user-journey scenarios from REQUIREMENTS.md. Place them under `tests/e2e/`. Run them and report.
>
> Append a "## E2E" section to `05-test/TEST_REPORT.md`. If the application doesn't run in a way that supports automated e2e (e.g., requires cloud creds), write a smoke-test stub and document the limitation in TEST_REPORT.md.
>
> Update or write `05-test/HANDOFF.md` reflecting both tester and e2e-tester outcomes.

## Sequential dispatch

Dispatch `tester` first, then `e2e-tester`.

## Post-dispatch

1. Verify `TEST_REPORT.md` and `HANDOFF.md` exist.
2. Parse TEST_REPORT.md for failing tests. If any fail → update RUN_STATE.md row #5 to `⚠ failing`, halt, surface to user before review.
3. Else → row #5 `✓ done`, artifacts → `05-test/TEST_REPORT.md`.
4. Return control — orchestrator advances to `phases/review.md`.
