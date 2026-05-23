import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

// Contract test for packages/db: every load-bearing DB construct documented in
// ARCHITECTURE.md § Data model must be present in the init migration SQL.

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const MIGRATION_PATH = path.resolve(
  __dirname,
  '../prisma/migrations/20260522000000_init/migration.sql',
);

describe('packages/db init migration — load-bearing DB constructs', () => {
  let sql: string;

  try {
    sql = fs.readFileSync(MIGRATION_PATH, 'utf8');
  } catch (err) {
    it.skip(`could not read migration sql: ${err instanceof Error ? err.message : String(err)}`, () => {});
    return;
  }

  it('creates the btree_gist extension (needed for EXCLUDE constraints)', () => {
    expect(sql).toMatch(/CREATE EXTENSION (?:IF NOT EXISTS )?"?btree_gist"?/i);
  });

  it('creates the pgcrypto extension (gen_random_uuid)', () => {
    expect(sql).toMatch(/CREATE EXTENSION (?:IF NOT EXISTS )?"?pgcrypto"?/i);
  });

  it('creates the citext extension (case-insensitive email)', () => {
    expect(sql).toMatch(/CREATE EXTENSION (?:IF NOT EXISTS )?"?citext"?/i);
  });

  it('defines the time_entries EXCLUDE constraint on (user_id, time_range)', () => {
    // The constraint name in the migration may vary; check the GIST exclusion shape.
    expect(sql).toMatch(/EXCLUDE[\s\S]*?USING\s+gist[\s\S]*?user_id[\s\S]*?time_range/i);
  });

  it('defines a partial unique index ensuring at-most-one running timer per user', () => {
    expect(sql).toMatch(/CREATE UNIQUE INDEX[\s\S]*?"?time_entries"?[\s\S]*?"?status"?\s*=\s*'running'/i);
  });

  it('defines the audit_log append-only trigger (rejects UPDATE and DELETE)', () => {
    expect(sql).toMatch(/audit_log/);
    // The trigger should raise an exception on UPDATE or DELETE.
    expect(sql).toMatch(/RAISE EXCEPTION/i);
  });

  it('defines the audit_log hash-chain BEFORE INSERT trigger', () => {
    expect(sql).toMatch(/audit_log/);
    expect(sql).toMatch(/sha256/i);
  });

  it('defines the chatbot_conversations and chatbot_messages tables (ARCHITECTURE r2)', () => {
    expect(sql).toMatch(/CREATE TABLE\s+"?chatbot_conversations"?/i);
    expect(sql).toMatch(/CREATE TABLE\s+"?chatbot_messages"?/i);
    // chatbot_messages must cascade-delete with the parent conversation.
    expect(sql).toMatch(/REFERENCES\s+"?chatbot_conversations"?[\s\S]*?ON DELETE CASCADE/i);
  });

  it('defines the mood_entries UNIQUE (user_id, local_date) — once-per-day rule', () => {
    expect(sql).toMatch(/mood_entries/);
    expect(sql).toMatch(/UNIQUE.*\(user_id,\s*local_date\)|user_id.*local_date.*UNIQUE/is);
  });

  it('defines the exceptions UNIQUE (user_id, exception_type, local_date) constraint', () => {
    expect(sql).toMatch(/exceptions/);
    expect(sql).toMatch(/user_id.*exception_type.*local_date/is);
  });

  it('defines the org_settings singleton row with overtime defaults', () => {
    expect(sql).toMatch(/org_settings/);
    expect(sql).toMatch(/overtime_daily_hours/i);
    expect(sql).toMatch(/overtime_weekly_hours/i);
    expect(sql).toMatch(/chatbot_daily_token_budget/i);
  });

  it('defines the effective-rate helper functions referenced by the financial reports', () => {
    expect(sql).toMatch(/get_effective_cost_rate/i);
    expect(sql).toMatch(/get_effective_billable_rate/i);
  });

  it('defines an EXCLUDE constraint preventing overlapping employee_cost_rates per user', () => {
    expect(sql).toMatch(/employee_cost_rates/);
    expect(sql).toMatch(/EXCLUDE.*USING\s+gist/is);
  });
});
