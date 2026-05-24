import { describe, it, expect } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  EmployeePerProjectCard,
  employeeRollupTitle,
  type EmployeeDrillIn,
} from '../app/dashboard/employees/[userId]/rollup-views.js';
import {
  ProjectBudgetCard,
  ProjectMembersCard,
  projectRollupTitle,
} from '../app/dashboard/projects/[projectId]/rollup-views.js';
import type { ProjectRollupRow } from '../src/lib/api-types.js';

/**
 * INC-007 (expansion) — the drill-in pages 200'd after the `date_range` fix but
 * then CRASHED with "Cannot read properties of undefined (reading 'map')"
 * because their FE-local types had drifted from the actual rollup responses:
 *
 *   - employee: FE read flat `display_name` / `per_project`, but the API returns
 *     nested `user.display_name` and `hours_by_project`.
 *   - project:  FE read flat `project_name` / `hours_budget` / `members`, but the
 *     API returns nested `project.{name,hours_budget}` and `hours_by_member`.
 *
 * These tests render the EXACT view helpers the pages use against the PINNED
 * rollup shapes (matching the backend-dev + api-designer lanes) and assert the
 * title + list mapping is correct. They also prove the OLD flat shape no longer
 * satisfies the renderer — feeding it crashes exactly as production did, so a
 * future drift back to flat fields would re-trip this test.
 *
 * Node-env `renderToStaticMarkup`, mirroring inc006-users-roles-guard.test.ts.
 */

// ---------------------------------------------------------------------------
// Representative PINNED-shape fixtures.
// ---------------------------------------------------------------------------

function employeeRollup(): EmployeeDrillIn {
  return {
    user: {
      id: 'usr_1',
      display_name: 'Ada Lovelace',
      email: 'ada@example.com',
      timezone: 'UTC',
    },
    date_range: { from: '2026-05-18', to: '2026-05-24' },
    hours_by_project: [
      { project_id: 'prj_1', project_name: 'Analytical Engine', hours: 12.5 },
      { project_id: 'prj_2', project_name: 'Difference Engine', hours: 6 },
    ],
    out_of_scope_project_count: 3,
    out_of_scope_hours: 4.25,
    timeline: [{ day: '2026-05-18', hours: 8 }],
    exceptions: [],
  };
}

function projectRollup(overrides: Partial<ProjectRollupRow> = {}): ProjectRollupRow {
  return {
    project: {
      id: 'prj_1',
      name: 'Analytical Engine',
      client_name: 'Babbage & Co',
      billing_mode: 'hourly',
      fixed_fee_amount: null,
      currency: 'USD',
      hours_budget: 40,
      ...(overrides.project ?? {}),
    },
    date_range: { from: '2026-05-18', to: '2026-05-24' },
    total_hours: 18.5,
    billable_hours: 16,
    hours_by_member: [
      { user_id: 'usr_1', display_name: 'Ada Lovelace', hours: 12.5 },
      { user_id: 'usr_2', display_name: 'Charles Babbage', hours: 6 },
    ],
    hours_by_task: [{ task_id: null, task_name: 'General', hours: 18.5 }],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Employee drill-in.
// ---------------------------------------------------------------------------

describe('employee rollup — pinned shape (INC-007)', () => {
  it('title reads nested user.display_name', () => {
    expect(employeeRollupTitle(employeeRollup())).toBe('Ada Lovelace');
  });

  it('title falls back to "Employee" before data arrives', () => {
    expect(employeeRollupTitle(undefined)).toBe('Employee');
  });

  it('renders one row per in-scope hours_by_project entry (NOT per_project)', () => {
    const html = renderToStaticMarkup(
      createElement(EmployeePerProjectCard, { data: employeeRollup() }),
    );
    expect(html).toContain('Analytical Engine');
    expect(html).toContain('Difference Engine');
  });

  it('renders the out-of-scope summary from the top-level count/hours fields', () => {
    const html = renderToStaticMarkup(
      createElement(EmployeePerProjectCard, { data: employeeRollup() }),
    );
    expect(html).toContain('Other projects (3 projects)');
  });

  it('omits the out-of-scope row when count is 0', () => {
    const data = employeeRollup();
    data.out_of_scope_project_count = 0;
    data.out_of_scope_hours = 0;
    const html = renderToStaticMarkup(createElement(EmployeePerProjectCard, { data }));
    expect(html).not.toContain('Other projects');
  });

  it('renders without crashing on an empty hours_by_project list', () => {
    const data = employeeRollup();
    data.hours_by_project = [];
    expect(() =>
      renderToStaticMarkup(createElement(EmployeePerProjectCard, { data })),
    ).not.toThrow();
  });

  it('would have CRASHED on the OLD flat shape (per_project undefined → .map throws)', () => {
    // The drifted response the FE used to assume: flat `per_project`, which the
    // API no longer returns, so `hours_by_project` is undefined here.
    const oldShape = {
      user_id: 'usr_1',
      display_name: 'Ada',
      per_project: [{ project_id: 'p', project_name: 'X', hours: 1 }],
      out_of_scope_project_count: 0,
      out_of_scope_hours: 0,
    } as unknown as EmployeeDrillIn;
    expect(() =>
      renderToStaticMarkup(createElement(EmployeePerProjectCard, { data: oldShape })),
    ).toThrow(/map/);
  });
});

// ---------------------------------------------------------------------------
// Project drill-in.
// ---------------------------------------------------------------------------

describe('project rollup — pinned shape (INC-007)', () => {
  it('title reads nested project.name', () => {
    expect(projectRollupTitle(projectRollup())).toBe('Analytical Engine');
  });

  it('title falls back to "Project" before data arrives', () => {
    expect(projectRollupTitle(undefined)).toBe('Project');
  });

  it('budget card reads project.hours_budget and total_hours', () => {
    const html = renderToStaticMarkup(
      createElement(ProjectBudgetCard, { data: projectRollup() }),
    );
    // 18.5 of 40 → 46%.
    expect(html).toContain('46%');
  });

  it('budget card is omitted when project.hours_budget is null', () => {
    const data = projectRollup({
      project: {
        id: 'prj_1',
        name: 'Analytical Engine',
        client_name: null,
        billing_mode: 'hourly',
        fixed_fee_amount: null,
        currency: 'USD',
        hours_budget: null,
      },
    });
    const html = renderToStaticMarkup(createElement(ProjectBudgetCard, { data }));
    expect(html).toBe('');
  });

  it('renders one row per hours_by_member entry (NOT members)', () => {
    const html = renderToStaticMarkup(
      createElement(ProjectMembersCard, { data: projectRollup() }),
    );
    expect(html).toContain('Ada Lovelace');
    expect(html).toContain('Charles Babbage');
  });

  it('renders without crashing on an empty hours_by_member list', () => {
    const data = projectRollup();
    data.hours_by_member = [];
    expect(() =>
      renderToStaticMarkup(createElement(ProjectMembersCard, { data })),
    ).not.toThrow();
  });

  it('would have CRASHED on the OLD flat shape (members undefined → .map throws)', () => {
    const oldShape = {
      project_id: 'prj_1',
      project_name: 'Analytical Engine',
      total_hours: 18.5,
      billable_hours: 16,
      hours_budget: 40,
      members: [{ user_id: 'u', display_name: 'X', hours: 1 }],
    } as unknown as ProjectRollupRow;
    expect(() =>
      renderToStaticMarkup(createElement(ProjectMembersCard, { data: oldShape })),
    ).toThrow(/map/);
  });
});
