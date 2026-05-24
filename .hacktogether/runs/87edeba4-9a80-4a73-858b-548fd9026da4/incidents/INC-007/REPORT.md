# INC-007 — Employee/project drill-in pages 400 (rollup calls omit `date_range`)

- **GitHub issue:** #9 (labeled `bug`)
- **Run:** 87edeba4-9a80-4a73-858b-548fd9026da4
- **Opened:** 2026-05-24
- **Severity:** Medium — two drill-in pages (`/dashboard/employees/:id`, `/dashboard/projects/:id`) show an error block instead of the rollup.
- **Flow:** STREAMLINED — gate (a) SKIPPED per user authorization (frontend-only, certain fix mirroring the #4 dashboard fix); gate (b) kept before push.

## Root cause (frontend-only)
The two drill-in pages call the rollup endpoints with NO query string:
- `apps/web/app/dashboard/employees/[userId]/page.tsx:24` → `apiFetch<EmployeeDrillIn>('/v1/reports/employees/${userId}/rollup')`
- `apps/web/app/dashboard/projects/[projectId]/page.tsx:17` → `apiFetch<ProjectRollupRow>('/v1/reports/projects/${projectId}/rollup')`

But the API requires `date_range` (`parseDateRange` throws when missing/malformed — reports.controller.ts:22-28; both rollup handlers read `@Query('date_range')`). → `400 VALIDATION_FAILED ("date_range must be in the form YYYY-MM-DD/YYYY-MM-DD")`. The main dashboard was fixed in #4 to pass this; the two drill-ins were never updated.

## Fix (mirror the existing dashboard pattern — `apps/web/app/dashboard/page.tsx:51,67,72-75`)
```ts
import { dateRangeParam, isoWeekRange, viewerTimeZone } from '@/lib/tz.js';
const range = isoWeekRange(anchor, zone);            // current ISO week in viewer TZ
const dateRange = dateRangeParam(range.fromDate, range.toDate);
apiFetch<EmployeeDrillIn>(`/v1/reports/employees/${params.userId}/rollup`, { query: { date_range: dateRange } });
// useQuery: enabled: !!dateRange (+ include date_range in queryKey)
```
Apply to BOTH drill-in pages. No backend change, no OpenAPI/contract change (endpoints already exist + spec'd; this is a missing required query param at runtime, not a route/field drift).

## Acceptance criteria (from issue #9)
1. `dashboard/employees/[userId]/page.tsx` loads the employee rollup for a sensible default range (current ISO week, like the main dashboard).
2. `dashboard/projects/[projectId]/page.tsx` loads the project rollup the same way.

## Scope guardrails
- Frontend-only. No backend/migration/contract change. No regress INC-001..006/FEAT-001. No `.github/`. No real-Entra path.

## HITL gates
- **(a)** SKIPPED (user-authorized for this small certain fix).  **(b)** before push (`closes #9`).
