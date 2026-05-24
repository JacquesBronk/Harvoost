---
phase: incidents/INC-007
agent: frontend-dev
started: 2026-05-24
finished: 2026-05-24
status: complete
---

# Summary
INC-007 (GitHub #9): the employee and project drill-in pages called the report
rollup endpoints with no query string, so the API rejected them with
`400 VALIDATION_FAILED ("date_range must be in the form YYYY-MM-DD/YYYY-MM-DD")`
and the pages showed an error block. Both pages now build a default
`date_range` = the current ISO week in the viewer's timezone (mirroring the
INC-004 team-dashboard fix in `apps/web/app/dashboard/page.tsx`), pass it as the
`date_range` query param, gate the query with `enabled: !!dateRange`, and key the
React Query cache by the range. Frontend-only; no API/OpenAPI/contract changes.

# Files touched
- apps/web/src/lib/tz.ts (modified) — added `currentIsoWeekRange(zone)` returning
  the inclusive Mon→Sun local-date bounds `{ from, to }` for the current ISO week.
  Mirrors the existing `currentMonthRange` helper and the dashboard's inline
  `this_week` math (`now.startOf('week')` ISO Mon → `+6 days` inclusive Sun).
- apps/web/app/dashboard/employees/[userId]/page.tsx (modified) — wired the range.
- apps/web/app/dashboard/projects/[projectId]/page.tsx (modified) — wired the range.
- apps/web/__tests__/inc007-drillin-date-range.test.ts (new) — regression test (9 tests).

# What downstream agents need to know
- Exact range-building used (identical on BOTH pages):
  ```ts
  const { data: user } = useCurrentUser();
  const zone = user?.timezone ?? viewerTimeZone();   // same derivation as dashboard/page.tsx
  const dateRange = useMemo(() => {
    const range = currentIsoWeekRange(zone);          // { from: 'YYYY-MM-DD', to: 'YYYY-MM-DD' }
    return dateRangeParam(range.from, range.to);      // 'YYYY-MM-DD/YYYY-MM-DD'
  }, [zone]);
  // useQuery:
  queryKey: ['dashboard', 'employee', params.userId, dateRange]        // employee
  queryKey: ['dashboard', 'project-rollup', params.projectId, dateRange] // project
  queryFn:  apiFetch<...>(`.../rollup`, { query: { date_range: dateRange } })
  enabled:  !!params.<id> && !!dateRange
  ```
- Decision (minor, for the run Decision log): I added a small shared helper
  `currentIsoWeekRange(zone)` to `tz.ts` rather than duplicating the dashboard's
  inline luxon math in two pages. It is consistent with the pre-existing
  `currentMonthRange(zone)` helper (INC-004), is node-env testable without jsdom,
  and keeps the two drill-in pages identical. The dashboard's own `this_week`
  branch was left untouched (no INC-004 regression).
- No date-range picker UI was added (explicitly out of scope per #9); both pages
  default to the current ISO week. The range is in the `queryKey` so a future
  picker can be added without a cache-staleness rework.
- Did NOT touch `apps/api/*`, the OpenAPI spec, `tests/contract`, `.github/`,
  `query-client.ts`, the OIDC flow, or any INC-001..006 surface.

# Open questions / unknowns
- None.

# Verification evidence
- `pnpm --filter @harvoost/web test` → 10 files, 107 passed (baseline 98 + 9 new
  in inc007-drillin-date-range.test.ts; the prior baseline count had grown to 98
  before this run). All green.
- `pnpm --filter @harvoost/web typecheck` → `tsc --noEmit` clean, no errors.
