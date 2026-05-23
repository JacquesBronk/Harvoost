import { describe, it, expect } from 'vitest';
import { HARVEST_COLUMNS, columnsForRole } from '../HarvestExportSchema';

describe('Harvest export column schema (REQUIREMENTS F9.3)', () => {
  it('contains the exact Harvest-compatible header set in the documented order', () => {
    const headers = HARVEST_COLUMNS.map((c) => c.header);
    // Headers must match Harvest verbatim — REQUIREMENTS F9.3.
    expect(headers).toEqual([
      'Date',
      'Client',
      'Project',
      'Project Code',
      'Task',
      'Notes',
      'Hours',
      'Hours Rounded',
      'Billable',
      'Invoiced',
      'Approved',
      'First Name',
      'Last Name',
      'Roles',
      'Employee',
      'Billable Rate',
      'Billable Amount',
      'Cost Rate',
      'Cost Amount',
      'Currency',
      'External Reference URL',
      'Department',
      'Estimate',
    ]);
  });

  it('flags exactly the four financial-only columns', () => {
    const financialOnly = HARVEST_COLUMNS.filter((c) => c.financialOnly).map((c) => c.header);
    expect(new Set(financialOnly)).toEqual(
      new Set(['Billable Rate', 'Billable Amount', 'Cost Rate', 'Cost Amount']),
    );
  });

  it('columnsForRole(true) returns the full set including financial columns', () => {
    const cols = columnsForRole(true);
    expect(cols).toHaveLength(HARVEST_COLUMNS.length);
    expect(cols.some((c) => c.header === 'Cost Rate')).toBe(true);
    expect(cols.some((c) => c.header === 'Cost Amount')).toBe(true);
    expect(cols.some((c) => c.header === 'Billable Rate')).toBe(true);
  });

  it('columnsForRole(false) strips Cost Rate, Cost Amount, Billable Rate, Billable Amount', () => {
    const cols = columnsForRole(false);
    const headers = cols.map((c) => c.header);
    expect(headers).not.toContain('Cost Rate');
    expect(headers).not.toContain('Cost Amount');
    expect(headers).not.toContain('Billable Rate');
    expect(headers).not.toContain('Billable Amount');
  });

  it('columnsForRole(false) preserves Currency, Notes, Hours, and other non-financial columns', () => {
    const cols = columnsForRole(false);
    const headers = cols.map((c) => c.header);
    expect(headers).toContain('Date');
    expect(headers).toContain('Client');
    expect(headers).toContain('Project');
    expect(headers).toContain('Hours');
    expect(headers).toContain('Currency');
  });

  it('columnsForRole(false) preserves the relative order of non-financial columns', () => {
    const full = columnsForRole(true).map((c) => c.header);
    const stripped = columnsForRole(false).map((c) => c.header);
    // Filter the full list to non-financial and assert it equals stripped.
    const filtered = full.filter((h) => !['Cost Rate', 'Cost Amount', 'Billable Rate', 'Billable Amount'].includes(h));
    expect(stripped).toEqual(filtered);
  });
});
