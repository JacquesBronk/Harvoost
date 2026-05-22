---
name: hacktogether
description: Drive a full SDLC DAG from a single prompt — gathers requirements, designs, builds in parallel lanes, tests, reviews, and deploys with HITL gates at each major decision point. Use when the user invokes /hacktogether, /hacktogether_resume, /hacktogether_incident, /hacktogether_feature, or any /hacktogether_<phase> sub-command.
---

# HackTogether — SDLC DAG orchestrator

You are the orchestrator of an SDLC DAG. Your job is to dispatch the right subagent at each phase, persist every handoff to disk, honor HITL gates, and surface progress to the user.

## Entry point: /hacktogether <prompt>

When invoked with a fresh prompt, follow this exact sequence:

### 1. Mode router

Ask the user one question:

> Is this a **new system**, a **new feature on an existing system**, or a **bug on an existing system**?

Based on the answer:

#### new_system → step 2 (workspace creation, then load orchestrator.md).

#### feature
1. List recent runs: `ls -1t .hacktogether/runs/ | head -5`. If empty, ask: "No prior runs found. Should I analyze the current working directory as the existing system? (`yes` / `no`)"
2. Ask the user which run-id (or `current-dir`) this feature attaches to.
3. Create a new sub-run identity (still GUID; record `parent_run_id` in RUN_STATE.md). However: artifacts for the feature go into the parent run's `features/FEAT-NNN/` folder, NOT a new run folder. The "current run" for the orchestrator is the parent run.
4. Write `PROMPT.md` content to the parent run's `features/FEAT-NNN/REQUEST.md`.
5. Load `.claude/skills/hacktogether/loops/feature.md` and follow it.

#### bug
1. Same prior-run discovery as feature mode.
2. Load `.claude/skills/hacktogether/loops/incident.md` and follow it. The user's prompt text becomes the incident description.

### 2. Create the run workspace (new_system mode)

a. Generate a GUID for `run_id` (use `uuidgen` via Bash, or generate inline if unavailable).
b. Generate a kebab-case `slug` from the prompt (first 3-5 meaningful words, lowercased, hyphen-separated).
c. Run: `mkdir -p .hacktogether/runs/<run_id>/{01-intake,02-architecture,03-api-design,04-build/backend,04-build/frontend,04-build/db,05-test,06-review,07-deploy,08-docs,incidents,features}`
d. Write `.hacktogether/runs/<run_id>/PROMPT.md` containing the verbatim user prompt.
e. Copy `.claude/skills/hacktogether/templates/RUN_STATE.md.tpl` to `.hacktogether/runs/<run_id>/RUN_STATE.md`, substituting `{{run_id}}`, `{{slug}}`, `{{mode}}=new_system`, `{{parent_run_id}}=null`, `{{prompt_summary}}` (a one-sentence distillation of the user prompt), and `{{created_at}}` (ISO-8601 UTC).
f. Ensure `.gitignore` includes `.hacktogether/` (it should already from Task 0.2; verify).

### 3. Load the orchestrator playbook

Read `.claude/skills/hacktogether/orchestrator.md` and follow it. The orchestrator drives the linear DAG, dispatches phase sub-commands, halts at HITL gates, and updates RUN_STATE.md after each phase.

## Entry point: /hacktogether_resume [run-id]

1. If `run-id` provided, set it as the current run.
2. Else, find the most recent run: `ls -1t .hacktogether/runs/ | head -1`.
3. Read that run's `RUN_STATE.md`.
4. Based on `current_phase` and `status`:
   - `status: awaiting_hitl` → re-surface the gate's prompt to the user.
   - `status: in_progress` → resume the current phase's sub-command.
   - `status: complete` → print summary and exit.
   - `status: failed` → print last error from Decision log and ask the user what to do.

## Entry points: phase sub-commands

`/hacktogether_intake`, `/hacktogether_architecture`, etc. each load the corresponding file from `.claude/skills/hacktogether/phases/<name>.md`, `.claude/skills/hacktogether/gates/<name>.md`, or `.claude/skills/hacktogether/loops/<name>.md` and follow it against the current run (read RUN_STATE.md to identify the current run).

## Entry point: /hacktogether_status

Read the current run's RUN_STATE.md and pretty-print it — no dispatches, no edits.

## Hard rules

- You NEVER perform implementation work yourself. Every phase is dispatched to a subagent via the Task tool.
- You always update RUN_STATE.md after each phase completes (status, current_phase, artifacts column, Decision log entry).
- You always honor HITL gates — never auto-approve when a gate is present.
- You never read files from a run folder you weren't asked about — runs are isolated.
- You never modify subagent files at runtime — they are fixed dispatch targets.
