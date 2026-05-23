// Harvest-compatible detailed time report column schema.
// Column NAMES and ORDER must match Harvest's exported XLSX exactly so existing
// downstream tooling (the customer's pipeline) keeps working without changes.
//
// Per REQUIREMENTS.md F9.3 — Cost columns are stripped server-side for non-financial roles.

export interface HarvestColumn {
  key: string;
  // Header verbatim — capitalisation matters.
  header: string;
  // Width in characters (used by exceljs to set column width).
  width: number;
  // Strip column when requester is not Admin/FinMgr.
  financialOnly?: boolean;
}

export const HARVEST_COLUMNS: ReadonlyArray<HarvestColumn> = [
  { key: 'date', header: 'Date', width: 12 },
  { key: 'client', header: 'Client', width: 28 },
  { key: 'project', header: 'Project', width: 28 },
  { key: 'project_code', header: 'Project Code', width: 14 },
  { key: 'task', header: 'Task', width: 24 },
  { key: 'notes', header: 'Notes', width: 60 },
  { key: 'hours', header: 'Hours', width: 8 },
  { key: 'hours_rounded', header: 'Hours Rounded', width: 14 },
  { key: 'billable', header: 'Billable', width: 10 },
  { key: 'invoiced', header: 'Invoiced', width: 10 }, // always blank in v1
  { key: 'approved', header: 'Approved', width: 10 },
  { key: 'first_name', header: 'First Name', width: 16 },
  { key: 'last_name', header: 'Last Name', width: 16 },
  { key: 'roles', header: 'Roles', width: 20 },
  { key: 'employee', header: 'Employee', width: 24 },
  { key: 'billable_rate', header: 'Billable Rate', width: 14, financialOnly: true },
  { key: 'billable_amount', header: 'Billable Amount', width: 14, financialOnly: true },
  { key: 'cost_rate', header: 'Cost Rate', width: 12, financialOnly: true },
  { key: 'cost_amount', header: 'Cost Amount', width: 14, financialOnly: true },
  { key: 'currency', header: 'Currency', width: 10 },
  { key: 'external_reference_url', header: 'External Reference URL', width: 24 }, // always blank in v1
  { key: 'department', header: 'Department', width: 16 },
  { key: 'estimate', header: 'Estimate', width: 10 }, // blank v1
];

export function columnsForRole(canSeeFinancial: boolean): ReadonlyArray<HarvestColumn> {
  if (canSeeFinancial) return HARVEST_COLUMNS;
  return HARVEST_COLUMNS.filter((c) => !c.financialOnly);
}
