import { describe, it, expect } from 'vitest';
import * as ExcelJS from 'exceljs';
import { XlsxWriterService } from '../../src/exports/xlsx-writer.service';
import type { XlsxRow } from '../../src/exports/xlsx-writer.service';
import { columnsForRole } from '@harvoost/shared';

// Integration test of XlsxWriterService against the real exceljs library.
// Reads the produced workbook back via exceljs to verify:
//   - column count + order matches columnsForRole()
//   - header row is bold
//   - cost columns ABSENT for non-financial role (NOT null-zeroed)
//   - cost columns PRESENT for financial role

const SAMPLE_ROW: XlsxRow = {
  date: '2026-05-15',
  client: 'Acme Inc',
  project: 'Phoenix Rewrite',
  project_code: 'PHX',
  task: 'Engineering',
  notes: 'Refactored auth module',
  hours: 7.5,
  hours_rounded: 7.5,
  billable: 'Yes',
  invoiced: '',
  approved: '',
  first_name: 'Alice',
  last_name: 'Admin',
  roles: 'admin',
  employee: 'Alice Admin',
  currency: 'ZAR',
  external_reference_url: '',
  department: '',
  estimate: '',
  // financial-only fields
  billable_rate: 1500,
  billable_amount: 11250,
  cost_rate: 600,
  cost_amount: 4500,
};

async function loadWorkbook(buffer: Buffer): Promise<ExcelJS.Workbook> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);
  return wb;
}

describe('XlsxWriterService.writeBuffer — schema correctness', () => {
  it('returns a non-empty Buffer with the .xlsx ZIP signature', async () => {
    const svc = new XlsxWriterService();
    const buf = await svc.writeBuffer([SAMPLE_ROW], true);
    expect(buf.length).toBeGreaterThan(100);
    // .xlsx is a ZIP — magic bytes PK\x03\x04.
    expect(buf[0]).toBe(0x50); // P
    expect(buf[1]).toBe(0x4b); // K
  });

  it('financial mode: includes Cost Rate + Billable Rate columns in correct order', async () => {
    const svc = new XlsxWriterService();
    const buf = await svc.writeBuffer([SAMPLE_ROW], true);
    const wb = await loadWorkbook(buf);
    const sheet = wb.worksheets[0]!;
    const expectedHeaders = columnsForRole(true).map((c) => c.header);
    const actualHeaders: string[] = [];
    sheet.getRow(1).eachCell({ includeEmpty: false }, (cell) => {
      actualHeaders.push(String(cell.value ?? ''));
    });
    expect(actualHeaders).toEqual(expectedHeaders);
    // The 4 financial columns must be present.
    for (const header of ['Cost Rate', 'Cost Amount', 'Billable Rate', 'Billable Amount']) {
      expect(actualHeaders).toContain(header);
    }
  });

  it('non-financial mode: cost + billable rate columns are STRIPPED from header row', async () => {
    const svc = new XlsxWriterService();
    const buf = await svc.writeBuffer([SAMPLE_ROW], false);
    const wb = await loadWorkbook(buf);
    const sheet = wb.worksheets[0]!;
    const expectedHeaders = columnsForRole(false).map((c) => c.header);
    const actualHeaders: string[] = [];
    sheet.getRow(1).eachCell({ includeEmpty: false }, (cell) => {
      actualHeaders.push(String(cell.value ?? ''));
    });
    expect(actualHeaders).toEqual(expectedHeaders);
    for (const header of ['Cost Rate', 'Cost Amount', 'Billable Rate', 'Billable Amount']) {
      expect(actualHeaders).not.toContain(header);
    }
  });

  it('header row is bolded (style verifies on the loaded workbook)', async () => {
    const svc = new XlsxWriterService();
    const buf = await svc.writeBuffer([SAMPLE_ROW], true);
    const wb = await loadWorkbook(buf);
    const sheet = wb.worksheets[0]!;
    const headerRow = sheet.getRow(1);
    // exceljs reads .font from the row OR cells; verify at least the first cell is bold.
    const firstCellFont = headerRow.getCell(1).font;
    expect(firstCellFont?.bold).toBe(true);
  });

  it('row count matches input length (no extra rows; header row=1)', async () => {
    const svc = new XlsxWriterService();
    const buf = await svc.writeBuffer([SAMPLE_ROW, SAMPLE_ROW, SAMPLE_ROW], true);
    const wb = await loadWorkbook(buf);
    const sheet = wb.worksheets[0]!;
    // rowCount includes the header row.
    expect(sheet.rowCount).toBe(4);
  });

  it('sheet is named "Detailed Activity" (matches Harvest convention)', async () => {
    const svc = new XlsxWriterService();
    const buf = await svc.writeBuffer([SAMPLE_ROW], true);
    const wb = await loadWorkbook(buf);
    expect(wb.worksheets[0]!.name).toBe('Detailed Activity');
  });

  it('empty rows array still produces a valid workbook with just the header', async () => {
    const svc = new XlsxWriterService();
    const buf = await svc.writeBuffer([], true);
    const wb = await loadWorkbook(buf);
    const sheet = wb.worksheets[0]!;
    expect(sheet.rowCount).toBe(1);
    expect(sheet.getRow(1).cellCount).toBeGreaterThanOrEqual(15);
  });

  it('writes hours as a numeric cell (not a string)', async () => {
    const svc = new XlsxWriterService();
    const buf = await svc.writeBuffer([SAMPLE_ROW], true);
    const wb = await loadWorkbook(buf);
    const sheet = wb.worksheets[0]!;
    // Find the Hours column by header.
    const headers = columnsForRole(true).map((c) => c.header);
    const hoursColIdx = headers.indexOf('Hours') + 1; // 1-based
    expect(hoursColIdx).toBeGreaterThan(0);
    const cell = sheet.getRow(2).getCell(hoursColIdx);
    expect(typeof cell.value).toBe('number');
    expect(cell.value).toBeCloseTo(7.5, 2);
  });
});
