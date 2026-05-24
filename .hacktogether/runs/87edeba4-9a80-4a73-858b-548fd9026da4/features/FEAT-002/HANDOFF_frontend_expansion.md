---
phase: FEAT-002
agent: frontend-dev
started: 2026-05-24
finished: 2026-05-24
status: complete
---

# Summary
Fixed the two pre-existing FE/API list-envelope drifts that left the FEAT-002 buttons
inert in the live UI (HANDOFF_e2e "Latent surprises" #3). Both `/timesheets` and
`/approvals` read their list rows from `.items`, but the backend returns these lists
under the offset-paginated `{ data, page, page_size, total_count }` envelope. The empty
reads cascaded into permanently-disabled controls: on `/timesheets` an empty entry list
made `hasDraft` false → Submit-week disabled; on `/approvals` an empty queue meant the
per-row `UnlockWeekButton` never rendered. The fix switches both pages to the existing
`OffsetPaginated<T>` type and reads `.data` — the exact pattern INC-004 reconciled for
the admin/rates lists. The FEAT-002 core UI (locked banner, Submit-week wiring,
UnlockWeekButton, the period-status `periodQuery`) is unchanged — only the list reads
that feed them were corrected. Added a hermetic regression test pinning the `{ data }`
envelope contract end-to-end and proving the old `.items` read yields empty (so a drift
back re-trips). Stayed entirely in `apps/web/*`.

# Files touched
- apps/web/app/timesheets/page.tsx (modified) — import `OffsetPaginated` (was `Paginated`);
  `apiFetch<OffsetPaginated<TimeEntry>>`; `entries = entriesQuery.data?.data ?? []`
  (was `.items`). No change to row rendering, submit wiring, banner, or `periodQuery`.
- apps/web/app/approvals/page.tsx (modified) — import `OffsetPaginated` (was `Paginated`);
  `apiFetch<OffsetPaginated<ApprovalQueueItem>>`; `items = queue.data?.data ?? []`
  (was `.items`). The page's existing `ApprovalQueueItem` interface (the pinned contract)
  and row/UnlockWeekButton rendering are untouched.
- apps/web/__tests__/feat002-list-envelope.test.ts (new) — 8 hermetic tests (node-env
  mocked-fetch + helper-extraction, matching feat002-period-lock / inc004-rates-query).

# What downstream agents need to know
- **Envelope decision (for the run Decision log):** `GET /v1/time-entries` and
  `GET /v1/approvals/queue` are read as `OffsetPaginated<T>` (`{ data, ... }`), aligning
  with the same envelope INC-004 reconciled for `/v1/cost-rates`, `/v1/billable-rates`,
  `/v1/users`, `/v1/projects`, `/v1/clients`. The FE now reads `.data` for these.
- **Scoped sweep, no collateral changes:** other pages that read `.items` were left alone
  on purpose — they hit genuinely different envelopes: the dashboard / team-dashboard uses
  `ScopedList` (`{ items, scope_meta }`); exceptions / leave / leave-approvals / chatbot
  use cursor-paginated `Paginated` (`{ items, next_cursor }`). Per guardrails I did not
  touch those endpoints. The `Paginated` type itself is unchanged and still used elsewhere.
- **`/approvals/final` already tolerant:** that page already reads both `.items` and `.data`
  for the same `/v1/approvals/queue` call (it groups raw `TimeEntry` rows for stage=final),
  so the backend's `{ data }` shape works there with no edit needed.
- **Depends on the parallel backend lane:** (a) the RBAC fix so an employee/manager sees
  their own week's entries (HANDOFF_e2e surprise #4), and (c) the rebuilt
  `GET /v1/approvals/queue?stage=manager` returning the enriched `ApprovalQueueItem` shape
  (`{ id, user_id, user_name, iso_week, total_hours, status, submitted_at }`) under
  `{ data }`. With those landed, both FEAT-002 buttons are now reachable in the live UI.
- **No regression to INC-001..007 / FEAT-001 / FEAT-002 core:** full web suite green; the
  locked banner + submit wiring + UnlockWeekButton are unchanged.

# Open questions / unknowns
- None. If the backend ships the manager queue WITHOUT pagination meta (a bare
  `{ data: [...] }`), the read still works — `OffsetPaginated<T>.data` is the only field
  the page consumes; `page`/`page_size`/`total_count` are unused here.

# Verification evidence
- `pnpm --filter @harvoost/web test` → **160 passed (13 files)**, up from the 152 baseline
  (+8 new in feat002-list-envelope.test.ts); zero failures, zero regressions.
- `pnpm --filter @harvoost/web typecheck` (`tsc --noEmit`) → clean, no errors.
- `grep '\.items' app/timesheets/page.tsx app/approvals/page.tsx` → only explanatory
  comments remain; no live `.items` reads on these two endpoints.
