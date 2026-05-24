---
phase: 04-build
agent: frontend-dev
started: 2026-05-24
finished: 2026-05-24
status: complete
---

# Summary
The /timesheets entry list filtered with `start_at_from` / `start_at_to` (full
ISO timestamps), but `GET /v1/time-entries` honors `date_from` / `date_to` as
inclusive `YYYY-MM-DD` local dates (backend `ListQuery` regex
`^\d{4}-\d{2}-\d{2}$`; openapi declares the same) and SILENTLY IGNORES the
`start_at_*` params. So the table actually listed ALL of the user's entries
across every week, and the Submit-week button (anchored on the newest draft in
the list) could lock the WRONG week off a stale future-week draft. Frontend-only
fix: send `date_from` / `date_to` as the displayed week's Mon→Sun `YYYY-MM-DD`
bounds, derived from the SAME `week` object (`isoWeekRange(anchorIso, zone)`)
that already drives the period banner and week label — so the listed entries,
the period status, and the Submit-week anchor all agree on the displayed week.
Backend, openapi.yaml, and contract tests were already correct and were NOT
touched.

# Files touched
- apps/web/app/timesheets/page.tsx (modified) — entry-list `useQuery`: query now
  sends `date_from: week.from` / `date_to: week.to` (was `start_at_from`/
  `start_at_to` = `week.startIso`/`week.endIso`); `queryKey` re-keyed to
  `['time-entries', 'own', week.from, week.to]` so the cache is keyed by week;
  added an explanatory comment.
- apps/web/src/lib/tz.ts (modified) — `isoWeekRange(localDate, zone)` now ALSO
  returns `from` / `to` (inclusive Mon→Sun `YYYY-MM-DD`), additively alongside
  the existing `startIso` / `endIso` / `weekLabel`. Same shape & convention as
  `currentIsoWeekRange`, but ANCHORED to `localDate` so /timesheets Prev/Next
  keeps re-windowing correctly.
- apps/web/__tests__/feat002-entries-datefilter.test.ts (new) — hermetic node-env
  mocked-fetch regression test (7 tests).

# What downstream agents need to know
- DECISION: I did NOT use `currentIsoWeekRange(zone)` for the list query as the
  dispatch suggested. That helper takes no anchor and always returns "this week",
  which would have broken the page's existing Prev/Next week navigation
  (`shiftWeek` / `anchorIso`) — entries would freeze on the current week while
  the banner/label/Submit anchor followed the navigated week, re-introducing the
  exact disagreement the fix targets. Instead I extended the page's existing
  ANCHORED `isoWeekRange(anchorIso, zone)` to expose `{from, to}` in the same
  `YYYY-MM-DD` Mon→Sun shape, so list + banner + Submit anchor all derive from
  one source and agree on whatever week is displayed. A test asserts the anchored
  bounds equal `currentIsoWeekRange` for the current week.
- The `isoWeekRange` change is purely additive; the only other caller
  (apps/web/app/dashboard/page.tsx) reads `.weekLabel` only and is unaffected.
- `OffsetPaginated<TimeEntry>` / `.data` read is unchanged and still correct.
- FEAT-002 UI invariants preserved: locked banner, Submit-week gating
  (`canSubmitWeek` + `hasDraft`), UnlockWeekButton, the `{ data }` envelope reads.

# Open questions / unknowns
- None.

# Verification evidence
- `pnpm --filter @harvoost/web typecheck` → clean (tsc --noEmit, no output).
- `pnpm --filter @harvoost/web test` → 14 files, 167 passed (baseline 160 → +7
  from the new datefilter suite; no regressions in INC-001..007 / FEAT-001 /
  FEAT-002 suites).
- New suite asserts: query sends `date_from`/`date_to` in `YYYY-MM-DD` matching
  the ISO week; does NOT send `start_at_from`/`start_at_to`; keeps `user_id`/
  `limit`; re-anchors the window across Prev/Next; and anchored bounds equal
  `currentIsoWeekRange` for "today".
