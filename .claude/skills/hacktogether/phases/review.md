# Phase: review

Subagents: `code-reviewer` + `security-reviewer` (sequential in this version).
Phase folder: `.hacktogether/runs/<run_id>/06-review/`
Inputs: build HANDOFFs, codebase
Outputs: `06-review/CODE_REVIEW.md`, `06-review/SECURITY_REVIEW.md`, `06-review/HANDOFF.md`, optionally `06-review/FIX_PLAN.md`

## Pre-dispatch

Update RUN_STATE.md: row #6 (review) → `▶ running`. Track attempt count in RUN_STATE.md's "Open items" (default attempt 1 of 2).

## Dispatch prompt — code-reviewer

> You are the `code-reviewer` agent. Run `<run_id>`.
> Phase folder: `06-review/`.
> Required context: RUN_STATE.md, REQUIREMENTS.md, ARCHITECTURE.md, build HANDOFFs, codebase.
>
> Review code quality, conventions, correctness, and adherence to the acceptance criteria. Use severity: blocking | critical | major | minor | nit. Only blocking and critical findings trigger the auto-loop back to build.
>
> Write `06-review/CODE_REVIEW.md` with the findings list. Exit.

## Dispatch prompt — security-reviewer

> You are the `security-reviewer` agent. Run `<run_id>`.
> Phase folder: `06-review/`.
> Same context plus secrets manifest at `.hacktogether/secrets.local.md` (do NOT exfiltrate values; verify usage shape).
>
> Apply OWASP Top 10 mental model. Severity scale: blocking | critical | major | minor | nit. Look for: injection, broken auth, sensitive data exposure, broken access control, secret leakage in logs/responses.
>
> Write `06-review/SECURITY_REVIEW.md`. Exit.

## Parallel fan-out (2-way)

Issue a SINGLE assistant message with TWO concurrent Task tool calls — one for code-reviewer, one for security-reviewer. Each uses its dispatch prompt from above.

Wait for both `06-review/CODE_REVIEW.md` and `06-review/SECURITY_REVIEW.md` to be present on disk before parsing for findings.

## Post-dispatch — auto-loop logic

1. Parse both review files for any finding with severity `blocking` or `critical`.
2. If none → write `06-review/HANDOFF.md` summarizing "clean". Update RUN_STATE.md row #6 → `✓ done`. Return — orchestrator advances to `gates/predeploy_signoff.md`.
3. If blocking/critical found:
   a. Increment attempt count in RUN_STATE.md Open items.
   b. If attempt ≤ 2:
      - Write `06-review/FIX_PLAN.md` using the template, listing every blocking/critical finding and the affected files.
      - Append Decision-log entry: `<iso8601> review loop attempt <N>/2 triggered: <count> blocking findings`.
      - Re-invoke `phases/build.md` with `--scope 06-review/FIX_PLAN.md`.
      - When build returns, re-invoke `phases/test.md`, then re-enter this phase from the top (attempt incremented).
   c. If attempt > 2:
      - Halt. Update RUN_STATE.md row #6 to `⚠ blocked`, status to `awaiting_hitl`.
      - Surface to user: "Review found <N> blocking issues after 2 fix attempts. See `06-review/FIX_PLAN.md`. Reply: `force-pass` (proceed to deploy anyway), `restart-review`, or `abort`."
