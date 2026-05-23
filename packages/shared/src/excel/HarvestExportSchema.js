"use strict";
// Harvest-compatible detailed time report column schema.
// Column NAMES and ORDER must match Harvest's exported XLSX exactly so existing
// downstream tooling (the customer's pipeline) keeps working without changes.
//
// Per REQUIREMENTS.md F9.3 — Cost columns are stripped server-side for non-financial roles.
Object.defineProperty(exports, "__esModule", { value: true });
exports.HARVEST_COLUMNS = void 0;
exports.columnsForRole = columnsForRole;
exports.HARVEST_COLUMNS = [
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
function columnsForRole(canSeeFinancial) {
    if (canSeeFinancial)
        return exports.HARVEST_COLUMNS;
    return exports.HARVEST_COLUMNS.filter((c) => !c.financialOnly);
}
//# sourceMappingURL=HarvestExportSchema.js.map