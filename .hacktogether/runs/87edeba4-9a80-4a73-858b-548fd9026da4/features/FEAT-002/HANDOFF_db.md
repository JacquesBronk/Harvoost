---
phase: FEAT-002
agent: database-admin (LANE 1 db-migration)
started: 2026-05-24
finished: 2026-05-24
status: complete
---

# Summary
Added the `timesheet_periods` table (per-user, per-ISO-week lock oracle) plus a DB-level
`BEFORE INSERT OR UPDATE` lock trigger on `time_entries`, per FEAT-002/DESIGN §1 and §3.
The migration is fully additive (new table, new function, new trigger; no `ALTER` on existing
tables, no backfill). It applied cleanly to the running dev DB with no drift. The trigger
rejects writes whose `start_at` lands in a LOCKED period (`status IN
('submitted','manager_approved','final_approved')`) with a dedicated custom SQLSTATE **`HV001`**,
and is a deliberate no-op on status-only updates (so submit/approval transitions are never
blocked by the very lock they create). Prisma `TimesheetPeriod` model + `User` back-relations
added and the client regenerated. All 4 SQL behaviour tests pass; db package typecheck + 21
baseline tests still green.

# Files touched
- `packages/db/prisma/migrations/20260524120000_timesheet_periods/migration.sql` (new)
- `packages/db/prisma/schema.prisma` (modified — added `TimesheetPeriod` model + two `User` back-relations)

# What downstream agents need to know

## >>> EXACT SQLSTATE THE BACKEND LANE MUST CATCH: `HV001` <<<
- Verified caught value: `SQLSTATE=[HV001]`, message
  `Cannot write into week 2026-W21 — it is submitted and locked (PERIOD_LOCKED).`,
  with `DETAIL: iso_year=2026 iso_week=21 status=submitted`.
- Class `HV` is NOT used by any built-in Postgres error class, and does not collide with the GiST
  overlap `23P01` (which the codebase maps via message-regex today) or unique-violation `23505`.
  Importantly it is also distinct from `P0001` (the default `raise_exception` code), so a generic
  raise elsewhere will not be mis-mapped.
- Backend (LANE 3) should map `HV001` → `PeriodLockedError` / `PERIOD_LOCKED` (409), mirroring how
  the GiST `23P01` overlap is mapped to a clean conflict today (see
  `apps/api/src/billable-rates/billable-rates.controller.ts:165` for the existing pattern). Prisma
  surfaces the SQLSTATE on `PrismaClientKnownRequestError.meta?.code` / via `e.code` on raw errors;
  if matching on message text, the substring `PERIOD_LOCKED` and `HV001` are both present.
- NOTE: the DB trigger is **defence-in-depth only**. DESIGN §3 still asks LANE 3 to do the
  app-level `assertPeriodWritable(...)` precheck in createManual/PATCH/start/switch that throws
  `PeriodLockedError` directly with the proper envelope. The trigger is the TOCTOU backstop and is
  what fires if a concurrent submit slips a write past the app precheck.

## Final table DDL (as applied — confirmed via `\d timesheet_periods`)
Columns exactly per DESIGN §1:
`id BIGSERIAL PK` · `user_id BIGINT NOT NULL FK→users(id) ON DELETE CASCADE` ·
`iso_year INT NOT NULL` · `iso_week INT NOT NULL CHECK (1..53)` · `week_start_date DATE NOT NULL` ·
`status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','submitted','manager_approved','final_approved','rejected'))` ·
`submitted_at TIMESTAMPTZ(6) NULL` · `submitted_by BIGINT NULL FK→users(id) ON DELETE SET NULL` ·
`manager_approved_at / final_approved_at / reopened_at TIMESTAMPTZ(6) NULL` ·
`created_at / updated_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW()`.
Constraints/indexes: `tp_user_week_unique UNIQUE (user_id, iso_year, iso_week)` (also serves the
lock lookup), `tp_status_idx (status)`, `tp_user_status_idx (user_id, status)`.

## Trigger logic (function `timesheet_period_lock_check`, trigger `timesheet_period_lock_trg`)
1. If `TG_OP = 'UPDATE'` AND `NEW.start_at IS NOT DISTINCT FROM OLD.start_at` → `RETURN NEW` (no-op).
   This is the critical rule: status-only updates (submit/approve/reject/admin-unlock) pass untouched.
2. If `NEW.start_at IS NULL` → `RETURN NEW` (belt-and-suspenders; `start_at` is NOT NULL in schema).
3. Look up `users.timezone` for `NEW.user_id` (fallback `'Europe/Amsterdam'`, unreachable for
   FK-valid rows since the column is NOT NULL with a default).
4. Compute `iso_year = EXTRACT(ISOYEAR FROM (NEW.start_at AT TIME ZONE tz))::int` and
   `iso_week = EXTRACT(WEEK FROM (NEW.start_at AT TIME ZONE tz))::int` — matches DESIGN §3's SQL,
   in the OWNER's IANA TZ.
5. `SELECT status FROM timesheet_periods WHERE user_id=NEW.user_id AND iso_year=y AND iso_week=w`.
6. If a row exists AND `status IN ('submitted','manager_approved','final_approved')` →
   `RAISE EXCEPTION ... USING ERRCODE = 'HV001'` with the iso_year/iso_week/status embedded.
   Otherwise (no row, or `open`/`rejected`) → `RETURN NEW`.
- Trigger: `BEFORE INSERT OR UPDATE ON time_entries FOR EACH ROW`. Idempotent install
  (`CREATE OR REPLACE FUNCTION`, `DROP TRIGGER IF EXISTS` then `CREATE TRIGGER`).
- It fires on every `time_entries` write but does meaningful work only on INSERT or date-move; with
  no period rows yet, it is a pure no-op for all current writes. Cost per write is one indexed
  SELECT on `tp_user_week_unique`. No regression to the audit-hash / `te_no_overlap` GiST /
  effective-rate functions.

## Prisma model
- Model `TimesheetPeriod` → table `timesheet_periods`. Fields (camelCase → snake_case `@map`):
  `id`, `userId`, `isoYear`, `isoWeek`, `weekStartDate (@db.Date)`, `status (@default("open"))`,
  `submittedAt`, `submittedBy`, `managerApprovedAt`, `finalApprovedAt`, `reopenedAt`, `createdAt`,
  `updatedAt`. Relations: `user` (`TimesheetPeriodUser`, onDelete Cascade), `submittedByUser`
  (`TimesheetPeriodSubmittedBy`, onDelete SetNull).
- `User` gained back-relations `timesheetPeriods` and `timesheetPeriodsSubmittedByMe`.
- The `iso_week` CHECK and the lock trigger are NOT expressible in Prisma schema and live in the
  migration SQL only (matches the repo convention noted in the schema header lines 15-17).

## Migration dir name
`20260524120000_timesheet_periods` (sorts after `20260523000000_feature_completion`). Applied via
`prisma migrate deploy`; `migrate status` reports "Database schema is up to date!" (no drift).
Manual DOWN (Prisma does not auto-run one) is documented at the foot of the migration.sql:
`DROP TRIGGER ...; DROP FUNCTION timesheet_period_lock_check(); DROP TABLE timesheet_periods;`.

# Open questions / unknowns
None. Scope held to `packages/db/*`. No `apps/*`, `tests/*`, `.github/`, or openapi files touched;
no existing tables or migrations altered.

# Verification evidence
- `pnpm --filter @harvoost/db prisma:validate` → "The schema at prisma/schema.prisma is valid".
- `pnpm --filter @harvoost/db prisma:generate` → "Generated Prisma Client (v5.22.0)".
- `pnpm --filter @harvoost/db migrate:deploy` → "Applying migration `20260524120000_timesheet_periods` … All migrations have been successfully applied."
- `pnpm --filter @harvoost/db migrate:status` → "Database schema is up to date!" (no drift).
- `\d timesheet_periods` → all 13 columns, 3 indexes (`tp_user_week_unique`, `tp_status_idx`,
  `tp_user_status_idx`), both CHECKs, both FKs present as specified. `pg_trigger` → `timesheet_period_lock_trg` present.
- SQL trigger behaviour (alice = user 3, TZ `Africa/Johannesburg`, current week 2026-W21), all
  rolled back (zero residue — final `count(*) timesheet_periods = 0`):
  - **TEST 1** INSERT `start_at` in locked W21 → FAILED `ERROR: ... it is submitted and locked (PERIOD_LOCKED)`, `DETAIL: iso_year=2026 iso_week=21 status=submitted`. PASS (block expected).
  - **TEST 2** status-only `UPDATE` of entry 69 (start_at unchanged, in locked W21), `draft→submitted` → SUCCEEDED (`UPDATE 1`). PASS (proves status-only updates pass).
  - **TEST 3** INSERT into open/no-row week 2026-W10 → SUCCEEDED (`INSERT 0 1`). PASS.
  - **TEST 4** date-move `UPDATE` of entry 69 to a new start_at still inside locked W21 → FAILED `HV001`. PASS (date-move blocked).
  - Caught SQLSTATE explicitly verified in a `DO`/`EXCEPTION WHEN OTHERS` block → `SQLSTATE=[HV001]`.
- `pnpm --filter @harvoost/db typecheck` → clean (no output, exit 0).
- `pnpm --filter @harvoost/db test` → 2 files, **21 passed** (baseline maintained).
```
Backend lane: catch SQLSTATE  HV001  → map to PERIOD_LOCKED (409).
```
