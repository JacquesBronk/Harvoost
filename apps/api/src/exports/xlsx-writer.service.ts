import { Injectable } from '@nestjs/common';
import * as ExcelJS from 'exceljs';
import { columnsForRole, type HarvestColumn } from '@harvoost/shared';

// XlsxWriterService — produces an .xlsx buffer matching Harvest's detailed
// time-report schema verbatim (column names + order per HarvestExportSchema).
// Cost columns are stripped server-side via columnsForRole(canSeeFinancial).
//
// We use exceljs's streaming writer to keep memory bounded for large exports.

export interface XlsxRow {
  date?: string;
  client?: string;
  project?: string;
  project_code?: string;
  task?: string;
  notes?: string;
  hours?: number;
  hours_rounded?: number;
  billable?: string | boolean;
  invoiced?: string;
  approved?: string | boolean;
  first_name?: string;
  last_name?: string;
  roles?: string;
  employee?: string;
  billable_rate?: number;
  billable_amount?: number;
  cost_rate?: number;
  cost_amount?: number;
  currency?: string;
  external_reference_url?: string;
  department?: string;
  estimate?: string;
}

@Injectable()
export class XlsxWriterService {
  // Generate a complete XLSX buffer. Caller is responsible for uploading.
  async writeBuffer(rows: XlsxRow[], canSeeFinancial: boolean): Promise<Buffer> {
    const columns = columnsForRole(canSeeFinancial);
    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'Harvoost';
    workbook.created = new Date();
    const sheet = workbook.addWorksheet('Detailed Activity');

    sheet.columns = columns.map((c: HarvestColumn) => ({
      header: c.header,
      key: c.key,
      width: c.width,
    }));
    // Style header row.
    sheet.getRow(1).font = { bold: true };
    sheet.getRow(1).alignment = { vertical: 'middle' };

    for (const row of rows) {
      // Filter to allowed keys only — exceljs accepts the object map directly.
      const out: Record<string, unknown> = {};
      for (const col of columns) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        out[col.key] = (row as any)[col.key] ?? '';
      }
      sheet.addRow(out);
    }

    const arrayBuffer = await workbook.xlsx.writeBuffer();
    return Buffer.from(arrayBuffer);
  }
}
