import { Card } from '@harvoost/ui';
import { formatHours } from '@/lib/tz.js';

/**
 * INC-007 — employee rollup drill-in render helpers.
 *
 * The page reads the EXACT employee-rollup contract:
 *   {
 *     user: { id, display_name, email, timezone },
 *     date_range: { from, to },
 *     hours_by_project: Array<{ project_id, project_name, hours }>,  // in-scope only
 *     out_of_scope_project_count: number,
 *     out_of_scope_hours: number,
 *     timeline: Array<{ day, hours }>,
 *     exceptions: Array<{ id, type, local_date, status, details }>,
 *   }
 *
 * The FE previously read the drifted flat shape (`display_name`, `per_project`)
 * which the API no longer returns, so `per_project.map` threw
 * "Cannot read properties of undefined (reading 'map')". These helpers are the
 * single source of the title + list mapping so the page and its test agree.
 */

export interface EmployeeRollupProject {
  project_id: string;
  project_name: string;
  hours: number;
}

export interface EmployeeDrillIn {
  user: {
    id: string;
    display_name: string;
    email: string;
    timezone: string;
  };
  date_range: { from: string; to: string };
  hours_by_project: EmployeeRollupProject[];
  out_of_scope_project_count: number;
  out_of_scope_hours: number;
  timeline: Array<{ day: string; hours: number }>;
  exceptions: Array<{
    id: string;
    type: string;
    local_date: string;
    status: string;
    details: unknown;
  }>;
}

/** Title shown in the page header: the employee's display name. */
export function employeeRollupTitle(data: EmployeeDrillIn | undefined): string {
  return data?.user?.display_name ?? 'Employee';
}

/** The "Per project" card body: in-scope projects + the out-of-scope summary row. */
export function EmployeePerProjectCard({ data }: { data: EmployeeDrillIn }) {
  return (
    <Card title="Per project" padded={false}>
      <ul className="divide-y divide-neutral-100">
        {data.hours_by_project.map((p) => (
          <li
            key={p.project_id}
            className="flex items-center justify-between px-4 py-2"
          >
            <span className="font-medium text-neutral-900">{p.project_name}</span>
            <span className="font-mono text-sm">{formatHours(p.hours)}</span>
          </li>
        ))}
        {data.out_of_scope_project_count > 0 ? (
          <li className="flex items-center justify-between bg-neutral-50/50 px-4 py-2 text-sm text-neutral-500">
            <span>Other projects ({data.out_of_scope_project_count} projects)</span>
            <span className="font-mono">{formatHours(data.out_of_scope_hours)}</span>
          </li>
        ) : null}
      </ul>
    </Card>
  );
}
