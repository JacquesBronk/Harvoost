import { Card } from '@harvoost/ui';
import { formatHours } from '@/lib/tz.js';
import type { ProjectRollupRow } from '@/lib/api-types.js';

/**
 * INC-007 — project rollup drill-in render helpers.
 *
 * The page reads the EXACT project-rollup contract (see `ProjectRollupRow` in
 * api-types.ts): nested `project` metadata, top-level `total_hours` /
 * `billable_hours`, member hours under `hours_by_member`, and the budget under
 * `project.hours_budget`. The FE previously read the drifted flat shape
 * (`project_name`, `hours_budget`, `members`) which the API no longer returns,
 * so `members.map` threw "Cannot read properties of undefined (reading 'map')".
 * These helpers are the single source of the title + budget + member mapping so
 * the page and its test agree.
 */

/** Title shown in the page header: the project's name. */
export function projectRollupTitle(data: ProjectRollupRow | undefined): string {
  return data?.project?.name ?? 'Project';
}

/** The optional Budget card — rendered only when `project.hours_budget` is set. */
export function ProjectBudgetCard({ data }: { data: ProjectRollupRow }) {
  const budget = data.project.hours_budget;
  if (!budget) return null;
  const pct = (data.total_hours / budget) * 100;
  return (
    <Card title="Budget" className="mb-4">
      <div className="flex items-center justify-between text-sm">
        <span className="text-neutral-600">
          {formatHours(data.total_hours)} of {formatHours(budget)}
        </span>
        <span className="font-mono text-xs text-neutral-500">{Math.round(pct)}%</span>
      </div>
      <div className="mt-2 h-2 overflow-hidden rounded-full bg-neutral-100">
        <div className="h-2 bg-brand-500" style={{ width: `${Math.min(100, pct)}%` }} />
      </div>
    </Card>
  );
}

/** The "Members" card body: one row per member from `hours_by_member`. */
export function ProjectMembersCard({ data }: { data: ProjectRollupRow }) {
  return (
    <Card title="Members" padded={false}>
      <ul className="divide-y divide-neutral-100">
        {data.hours_by_member.map((m) => (
          <li
            key={m.user_id}
            className="flex items-center justify-between px-4 py-2"
          >
            <span className="font-medium text-neutral-900">{m.display_name}</span>
            <span className="font-mono text-sm">{formatHours(m.hours)}</span>
          </li>
        ))}
      </ul>
    </Card>
  );
}
