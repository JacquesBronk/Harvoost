# FEAT-002 — DESIGN (Option F: real timesheet-period entity + submit/approval workflow)

Run: 87edeba4-9a80-4a73-858b-548fd9026da4 · Date: 2026-05-24 · Author: architect
Gate: (a) architecture approval. Flow: feature loop (full gates).

> This is a **focused design doc**. It does NOT rewrite `02-architecture/ARCHITECTURE.md`
> (1389 lines, canonical). It references it. Precedent for a focused doc that sits beside the
> canonical architecture: `02-architecture/ADR-0001-oidc-provider-agnostic.md`.

## Locked-in gate-(a) decisions this designs to
- **D2 = Option F** — a real `timesheet_periods` entity with its own lifecycle + submit/approve workflow.
- **D1 = per-user, per-ISO-week, in the user's IANA TZ** (`User.timezone`, fallback `OrgSetting.defaultTimezone`).
- **D3 = dedicated `PERIOD_LOCKED` (409)**, mirroring `EntryLockedError`/`ENTRY_LOCKED`.
- **D4 = reuse the existing per-entry `admin-unlock`; leave leave-DELETE unchanged** — reconciled in §5.

---

## Think-before-act (the load-bearing reasoning)

**1. Actual requirement.** Stop an already-reviewed week from being silently altered by a create /
back-date / PATCH-move into it, AND give the system a real "submit the week → approve the week → week
is locked" lifecycle (the user chose F over the query-only lock L). The harm is retroactive mutation
of a signed-off week; the feature is a *period that owns the closed/open state*.

**2. What exists that constrains this (grounded in code).**
- Approval today is **purely per-entry** (`approvals.controller.ts`): `managerAction` flips
  `submitted→manager_approved` per `entry_id`; `finalAction` flips `manager_approved→final_approved`
  per `entry_id` and enforces stage1≠stage2 by reading the latest `to_status='manager_approved'`
  actor from `time_entry_state_history` (`:96`). `adminUnlock` flips ONE entry to `draft` (`:144`).
- `LOCKED_STATUSES = {submitted, manager_approved, final_approved}` (`time-entries.controller.ts:74`)
  is enforced on the entry's OWN status in PATCH (`:355`) and DELETE (`:403`) via `EntryLockedError`.
  It is NOT checked in `createManual` (`:300`) and NOT against the *destination week* on PATCH-move.
- The FE **already** calls `POST /v1/time-entries/{id}/submit` with `{ scope: 'week' }`
  (`apps/web/app/timesheets/page.tsx:67`) — this is the INC-004 `KNOWN_ROUTE_GAP`
  (`tests/contract/src/contract-spec.ts:194`): the route 404s today. The submit intent is *already
  week-scoped at the UI*; only the server route is missing.
- The openapi already specs `POST /v1/time-entries/{entry_id}/submit` with `scope: entry|week` and an
  `iso_week` field (`openapi.yaml:1277, 3522`), and an `iso_week` query param on
  `/v1/approvals/queue` (`:1783`) — the contract already anticipates ISO-week as the period key.
- `time_entries.status` has a DB CHECK constraint (`migration init:189`); the two-stage machine,
  `te_no_overlap` GiST, the partial unique indexes, and the audit hash-chain trigger are all
  load-bearing existing infrastructure.
- `User.timezone` (default `Europe/Amsterdam`, `schema.prisma:40`) + `OrgSetting.defaultTimezone`
  exist. `MoodWeeklyAggregate(isoYear, isoWeek)` shows the codebase's ISO-week storage convention.

**3. Accidental vs essential complexity.** The essential complexity is: a period must (a) be keyable
from any entry's `start_at`, (b) own a lifecycle parallel to the entry two-stage machine, (c) stay
consistent with the per-entry statuses that managers/finmgrs already act on, and (d) be the lock
oracle. The trap that adds *accidental* complexity is duplicating the approval state machine. The
design below **reuses the existing per-entry approvals controller as the transition engine** and makes
the period a *derived-but-persisted* aggregate, so we add a table and a submit route but do NOT fork
the approval logic.

**4. What a dev needs to know in 6 months.** "A `timesheet_period` row is the lock oracle for
(user, ISO-week). Submit creates/advances it and flips its draft entries to `submitted`. Manager/final
approval still happens per-entry through the existing approvals controller; the period status is
recomputed from its entries after each transition. The period in a locked status rejects writes whose
`start_at` lands in that week with `PERIOD_LOCKED`."

**5. Simplest thing that works for F.** Period status is **derived from its entries** (not a parallel
hand-maintained machine), persisted for indexability + a stable lock check + an explicit `submitted_at`
audit anchor. Submit is the only genuinely new write path; approval reuses what exists.

**6. What we trade away.** A fully independent period state machine (e.g. a period that can be
"approved" while containing a `draft` entry) is rejected — it would desync from the per-entry machine
managers actually operate. We trade that theoretical independence for guaranteed consistency and far
less new code. Acceptable: issue #6 is about *integrity*, and a derived status cannot lie about its
entries.

---

## 1. Data model / migration

### New table: `timesheet_periods`

One row per (user, ISO-week). Created lazily on first submit of that week (not pre-seeded).

| Column | Type | Notes |
|---|---|---|
| `id` | `BIGINT PK` (autoincrement) | matches high-volume table convention |
| `user_id` | `BIGINT NOT NULL` FK→`users(id)` ON DELETE CASCADE | the period owner |
| `iso_year` | `INT NOT NULL` | ISO-8601 week-numbering year (mirrors `mood_weekly_aggregates`) |
| `iso_week` | `INT NOT NULL CHECK (iso_week BETWEEN 1 AND 53)` | mirrors `mwa` CHECK |
| `week_start_date` | `DATE NOT NULL` | Monday 00:00 in the user's TZ, stored as a DATE; the deterministic, TZ-resolved anchor. Half-open week is `[week_start, week_start+7d)` in the user's TZ. |
| `status` | `TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','submitted','manager_approved','final_approved','rejected'))` | period lifecycle — parallels `time_entries.status` minus `running`/`draft`; `open` replaces draft as the editable state |
| `submitted_at` | `TIMESTAMPTZ(6)` NULL | set on first submit |
| `submitted_by` | `BIGINT` NULL FK→`users(id)` ON DELETE SET NULL | the actor who submitted (always the owner in v1) |
| `manager_approved_at` | `TIMESTAMPTZ(6)` NULL | set when the period reaches stage-1 |
| `final_approved_at` | `TIMESTAMPTZ(6)` NULL | set when the period reaches stage-2 |
| `reopened_at` | `TIMESTAMPTZ(6)` NULL | set when an admin-unlock pulls the period back to `open` (D4) |
| `created_at` | `TIMESTAMPTZ(6) NOT NULL DEFAULT NOW()` | |
| `updated_at` | `TIMESTAMPTZ(6) NOT NULL DEFAULT NOW()` | bumped on every status recompute |

**Uniqueness:** `CONSTRAINT tp_user_week_unique UNIQUE (user_id, iso_year, iso_week)`. The
`(user_id, week_start_date)` pair is functionally equivalent; we keep `(iso_year, iso_week)` as the
unique key to match `mood_weekly_aggregates` and the openapi `iso_week` contract, and carry
`week_start_date` as the TZ-resolved comparison anchor for the lock query.

**Indexes:**
- `tp_user_week_unique` (above) — also serves the lock lookup `WHERE user_id=? AND iso_year=? AND iso_week=?`.
- `CREATE INDEX tp_status_idx ON timesheet_periods (status)` — for approval-queue period rollups.
- `CREATE INDEX tp_user_status_idx ON timesheet_periods (user_id, status)` — "my open/submitted weeks".

**No FK from `time_entries` to `timesheet_periods`.** Entries are NOT given a `period_id` column.
Rationale: the period is derived by (user_id, ISO-week-of-start_at), which is a pure function of fields
the entry already has. Adding a denormalized FK creates a consistency burden (it must be recomputed
whenever `start_at` moves across a week boundary on PATCH) for no lookup benefit — the lock query keys
on `(user_id, iso_year, iso_week)` which the unique index already covers. **This is the single most
important "resist accidental complexity" call in the design.** The link between an entry and its period
is *computed*, not *stored*.

### Source of truth & consistency

**`time_entries.status` stays the source of truth for an entry's approval state.** The period status is
a **derived rollup** that we persist for lockability and audit anchoring. The invariant:

```
period.status = rollup(statuses of all the user's entries whose start_at ∈ this ISO-week)
  where rollup = the LEAST-advanced approval state among entries that are in the approval pipeline,
  with running/draft entries treated as "not yet submitted" (→ keeps the period 'open' or 'submitted'
  per the rules in §2), and a 'rejected' entry pulling the period to 'rejected'.
```

A period row exists ⇔ the week has been submitted at least once. An open week with only draft entries
has **no row** (= implicitly `open`), exactly like Option L's "empty week is never locked." This keeps
future weeks open for the FEAT-001 leave/holiday case for free.

**Why derived-not-independent:** managers and finmgrs continue to act on individual `entry_ids` through
the existing approvals controller (we are NOT rewriting it). If the period had an independent status, a
manager approving 4 of 5 entries would desync it. By recomputing `period.status` from its entries after
every transition, the period can never claim "approved" while an entry is still `submitted`.

### Migration (additive, non-destructive)

New timestamped migration dir `packages/db/prisma/migrations/2026052XmmHHMM_timesheet_periods/migration.sql`,
following the `feature_completion` precedent (`IF NOT EXISTS`, inline CHECK, FK ON DELETE CASCADE/SET NULL):

- `CREATE TABLE IF NOT EXISTS "timesheet_periods" (...)` per the column table above.
- The `UNIQUE` constraint + the two secondary indexes (`IF NOT EXISTS`).
- Mirror the model in `schema.prisma` (new `TimesheetPeriod` model + the `User` back-relation), per the
  schema's stated convention (header comment lines 15-17).
- **No `ALTER` on `time_entries`. No backfill required** (periods are created lazily on submit; the only
  paths that reach a locked status today are seeding/the approvals controller, and a period row is
  created the first time submit runs). **Confirmed: zero destructive change, zero data migration.**

> Optional follow-up (NOT in this migration): a `BEFORE INSERT/UPDATE` trigger on `time_entries` that
> rejects a write into a locked period at the DB layer (closes the TOCTOU race in §3). Deferred — the
> app-level check matches the existing `te_no_overlap` app-precheck pattern. Flagged in §7.

---

## 2. Lifecycle & state machine

Period states: **`open` → `submitted` → `manager_approved` → `final_approved`**, with `rejected` as a
side-state that returns to `open` for fixes. This deliberately parallels the entry machine
(`draft↔open`, then the shared `submitted/manager_approved/final_approved/rejected`).

```
            submit (owner)                manager approve            final approve
 (no row) ─────────────▶ submitted ───────────────────▶ manager_approved ──────────────▶ final_approved
   =open  ◀───┐              │ │                              │  │                              │
             │              │ └── manager reject ──▶ rejected─┘  └── final reject ──▶ rejected  │
   admin-unlock any entry   │         │                                  │                      │
   in the period (D4) ──────┴─────────┴──────────────────────────────────┴──────────────────────┘
                                          (recompute → open)
```

### Transitions, RBAC, and effect on entries

| Transition | Trigger / RBAC | Effect on the period's entries | Effect on the period row |
|---|---|---|---|
| **Submit** `open→submitted` | `POST /v1/time-entries/{id}/submit` `scope=week`. **Employee submits their OWN week only.** (self-only, mirrors PATCH self-check `:350`.) | All `draft` entries in the week → `submitted` (atomic, in a tx). `running` entries are skipped (cannot submit a live timer) and reported in `skipped`. Already-`submitted+` entries skipped. Writes `time_entry_state_history` rows (`draft→submitted`, actor=owner) — reuses the existing history table. | Upsert row; `status='submitted'`, `submitted_at=NOW()`, `submitted_by=owner`. |
| **Manager approve** `submitted→manager_approved` | **Existing** `POST /v1/approvals/timesheets/manager` (`@Roles('manager','admin')`). Unchanged controller. | Per-entry `submitted→manager_approved` exactly as today. | **Recomputed** after the batch: if ALL the week's pipeline entries are now ≥`manager_approved`, period→`manager_approved` (+`manager_approved_at`). |
| **Final approve** `manager_approved→final_approved` | **Existing** `POST /v1/approvals/timesheets/final` (`@Roles('finmgr','admin')`). **stage1≠stage2 invariant preserved** (read from `time_entry_state_history` per entry, `:96`). | Per-entry `manager_approved→final_approved` exactly as today. | **Recomputed**: if ALL pipeline entries are `final_approved`, period→`final_approved` (+`final_approved_at`). |
| **Reject** (either stage) | Existing manager/final reject. | Per-entry → `rejected` as today. | **Recomputed** → `rejected` (the week reopens for fixes; `rejected ∉ LOCKED → writes allowed again`). |
| **Admin unlock** | **Existing** `POST /v1/approvals/admin-unlock/{entryId}` (`@Roles('admin')`, reason ≥20). | One entry → `draft` as today. | **Recomputed** → if any entry drops below `submitted`, period→`open`, `reopened_at=NOW()`. (D4, see §5.) |

**Does the period gate the entries, or do entries move in lockstep?** Both, by role:
- *Submit* moves entries in lockstep (period drives: it is the new write path that flips draft→submitted).
- *Approve/reject/unlock* are entry-driven (the period is recomputed to follow). The period **gates new
  writes** (the lock, §3) but does not independently advance entry statuses on approval.

This split is the crux: **submit is period-level (one action, whole week); approval stays per-entry**
(managers keep their existing batch grain and queue). The period status is the consistent rollup.

### Recompute rule (the rollup function)

After any transition touching a week's entries, recompute in the same transaction:
```
entries := time_entries WHERE user_id=U AND start_at ∈ week(W, user_tz) AND status <> 'running'
if entries is empty            → delete the period row (or leave at 'open'); week is open
elif any entry = 'rejected'    → period 'rejected'
elif all entries = 'final_approved'   → period 'final_approved'
elif all entries >= 'manager_approved'→ period 'manager_approved'
elif all entries >= 'submitted'       → period 'submitted'
else (≥1 draft remains)        → period 'open'   (partial week, not yet fully submitted)
```
`running` is excluded so a live timer started in an open week never blocks the rollup. **Locking key
(§3): the period is locked iff `status ∈ {submitted, manager_approved, final_approved}`** — identical
set to `LOCKED_STATUSES`, by design.

---

## 3. Lock enforcement (`PERIOD_LOCKED`)

**Rule:** a write is rejected with `PERIOD_LOCKED` (409) iff the candidate entry's `start_at`, rendered
in the **owner's IANA TZ**, falls in an ISO-week whose `timesheet_periods` row exists AND has
`status ∈ {submitted, manager_approved, final_approved}`. No row, or a row in `open`/`rejected` ⇒ allowed.

Week-of-`start_at` computed in SQL in the user's TZ:
```sql
-- iso_year/iso_week of a candidate timestamp in the user's TZ:
EXTRACT(ISOYEAR FROM ($ts::timestamptz AT TIME ZONE $user_tz))::int AS iso_year,
EXTRACT(WEEK    FROM ($ts::timestamptz AT TIME ZONE $user_tz))::int AS iso_week
```
Lock check = `SELECT status FROM timesheet_periods WHERE user_id=$U AND iso_year=$y AND iso_week=$w` and
test membership in the locked set. A shared private helper `assertPeriodWritable(tx, userId, userTz,
startAt)` in the time-entries controller (or a small `PeriodLockService`) is the single enforcement
point reused by every handler below.

### Enforcement points (precise)

| Handler | Loc | Change |
|---|---|---|
| `createManual` `POST /v1/time-entries` | `:300` | **ADD** `assertPeriodWritable(start_at)` before insert. **Load-bearing** (the create/back-date hole #6 names). |
| `PATCH /v1/time-entries/:id` | `:337` | **ADD** destination-period check when `start_at` (or `end_at`) changes: evaluate the **new** `start_at`'s week → `PERIOD_LOCKED`. Keep the existing own-status `ENTRY_LOCKED` check (`:355`, fires first). **Load-bearing — the PATCH-move hole the product-analyst flagged.** The lock query is on the *period table*, so self-exclusion is moot (a single `draft` entry being moved within its own still-`open` week has an `open` period and passes). |
| `POST /v1/time-entries/start` | `:151` | **ADD defensively.** Inserts `start_at=NOW()`; if NOW() lands in a locked current week (possible if a user submitted the in-progress week early) the start is correctly rejected. Cheap, satisfies the issue's literal ask. |
| `POST /v1/time-entries/switch` | `:235` | **ADD defensively**, same as `start`. |
| `DELETE /v1/time-entries/:id` | `:394` | **No change** (D4 — see §5). |

**Future-dating stays allowed** (FEAT-001 leave/holiday): a future or empty week has no period row
(or an `open` one) ⇒ never locked. Pinned as a test (§6).

**Boundary entry rule:** an entry is bucketed by its **`start_at`'s** ISO-week only (a Sun-night→Mon
entry belongs to its start week). Deterministic, matches how `list`/approvals bucket by `start_at`.
Documented + test-pinned.

**Submit/approve writes are exempt from the lock** by construction: submit *creates* the locked state
(it runs the transition, not a `createManual`/PATCH write path); approvals operate on `status` only and
never touch `start_at`/`end_at`, so they never pass through `assertPeriodWritable`.

---

## 4. API surface

### New: period-level submit (fills the KNOWN_ROUTE_GAP)

`POST /v1/time-entries/{entry_id}/submit` — **register the route the openapi already specs**
(`openapi.yaml:1277`) and the FE already calls (`timesheets/page.tsx:67`). This is the chosen submit
path. See §"Decision: per-entry vs period submit" below.

- **Auth:** any authenticated user; **self-only** (the `entry_id` must belong to the caller, else 404,
  mirroring PATCH `:350`).
- **Request:** `SubmitTimeEntryRequest` (already in spec): `{ scope: 'entry'|'week' = 'entry', iso_week?: '^\d{4}-W\d{2}$' }`.
  v1 wires **`scope=week`** (what the FE sends) and `scope=entry` (single-entry submit, trivial subset).
- **Response (already specced):** `{ submitted_ids: int64[], skipped: [{ entry_id, reason }] }`.
- **Behavior:** resolve the target ISO-week (entry's own week, or `iso_week` override) in the owner's
  TZ; in one tx, flip all the week's `draft` entries → `submitted`, write history rows, upsert the
  `timesheet_periods` row to `submitted`. `running`/already-locked entries → `skipped`.

### Changed: approvals (no new endpoints — recompute hook only)

`POST /v1/approvals/timesheets/manager`, `.../final`, `.../admin-unlock/{entryId}` are **unchanged in
contract**. Internally each gains a `recomputePeriod(userId, isoYear, isoWeek)` call inside its existing
transaction so the period status follows the entries. **No new approval endpoints** — the period is not
approved directly; it is approved *by* approving its entries. This is the deliberate "reuse the engine"
call from the think-before-act.

### New: read period status

`GET /v1/timesheet-periods` (list, self + RBAC-visible) and/or `GET /v1/timesheet-periods/{iso_week}`
(single, self) returning:
```json
{ "user_id": 42, "iso_year": 2026, "iso_week": 21, "week_start_date": "2026-05-18",
  "status": "submitted", "submitted_at": "...", "manager_approved_at": null,
  "final_approved_at": null, "reopened_at": null,
  "entry_counts": { "draft": 0, "submitted": 5, "manager_approved": 0, "final_approved": 0, "rejected": 0 } }
```
This backs the FE "week is submitted/locked" banner and the "Submit week" button enable/disable. The
api-designer specs exact pagination/shape; the FE currently infers week state from entry statuses, so
this endpoint is *additive* (the FE can adopt it incrementally).

### `PERIOD_LOCKED` error envelope

Add to `packages/shared/src/errors/index.ts` alongside `EntryLockedError` (mirrors it exactly):
```ts
// ErrorCode enum: add  PERIOD_LOCKED: 'PERIOD_LOCKED'
export class PeriodLockedError extends DomainError {
  constructor(isoYear: number, isoWeek: number, status: string) {
    super(ErrorCode.PERIOD_LOCKED,
      `Cannot write into week ${isoYear}-W${String(isoWeek).padStart(2,'0')} — it is ${status} and locked.`,
      409, { iso_year: isoYear, iso_week: isoWeek, status });
    this.name = 'PeriodLockedError';
  }
}
```
The global `HttpExceptionFilter` already maps any `DomainError` to `{code,message,details}`
(`http-exception.filter.ts:23`) — **no filter change**.

### `@harvoost/contract` impact

`@harvoost/contract` = the contract-test package (`tests/contract`). Impact:
1. **openapi.yaml** — add `PERIOD_LOCKED` to the `ErrorCode` enum (`:3092`); add the `submit` op to
   `LOAD_BEARING` (it stops being a `KNOWN_ROUTE_GAP`); add `409 PERIOD_LOCKED` responses to
   `createManual`/PATCH; add the `/v1/timesheet-periods` op(s) + a `TimesheetPeriod` schema.
2. **`tests/contract/src/contract-spec.ts`** — **remove** `'POST /v1/time-entries/{param}/submit'` from
   `KNOWN_ROUTE_GAP` (`:194`) and move it into the load-bearing/registered set (the route now exists).
   This is the contract reconciliation INC-004 deferred.
3. The contract test asserts route presence, not the ErrorCode enum members (confirmed in
   `contract.test.ts`), so adding `PERIOD_LOCKED` is non-breaking.

---

## 5. Admin override — D4 reconciliation (explicit)

**The tension:** with a period entity that *owns* a locked state, how does an admin reopen a week using
the existing per-entry `POST /v1/approvals/admin-unlock/{entryId}`?

**Decision: Option (a) — admin-unlocking any entry recomputes its period back to `open`. No new
period-reopen endpoint.**

Mechanics: `adminUnlock` already flips one entry to `draft` (`approvals.controller.ts:144`). We add — in
its existing transaction — a `recomputePeriod(userId, isoYear, isoWeek)` call. Per the rollup rule
(§2), the moment one entry drops to `draft`, the period has a `<submitted` member ⇒ `status='open'`,
`reopened_at=NOW()`. The week is unlocked; writes are accepted again. **This is structurally clean
because the period status is derived, not independent** — there is nothing to "also reset"; reopening
falls out of the recompute for free.

**Why NOT add a period-reopen endpoint:** it would be a second source of truth for "is this week open"
that could disagree with the entries' statuses (admin reopens the period but entries stay
`final_approved` → the lock says open but the entries say locked → the next approval-queue render is
incoherent). D4 says reuse per-entry admin-unlock unless structurally unavoidable; with a derived period
it is genuinely avoidable, so we don't add it.

**One honest UX wrinkle (flagged, not solved here):** to reopen a fully-`final_approved` week the admin
must unlock the entries (today, one call per entry). That is the *existing* admin-unlock ergonomics, not
a regression this feature introduces. A future "unlock week" convenience that loops the existing
per-entry unlock (same audit rows, no new authority) is a tracked follow-up — **out of scope for
FEAT-002** unless the UX gate demands it. Recorded in §7 as an open question for the orchestrator.

**Leave DELETE / entry DELETE:** unchanged (D4). A DELETE of a `draft` entry in an otherwise-locked week
is still gated by the entry's own status today; deleting a `draft` entry from a `submitted` week removes
work rather than fabricating approved work, and the period recompute (if we wire DELETE into recompute —
optional, low value) would only ever *relax* the period. We leave DELETE untouched to honor D4's
smallest-surface intent. Flagged in §7 if reviewers want DELETE-into-locked-week blocked too.

---

## 6. Build plan

### Lanes & file-ownership partition (no two lanes write the same file)

| Lane | Owns (writes) | Depends on | Deliverable |
|---|---|---|---|
| **L1 db-migration** | `packages/db/prisma/migrations/2026052X_timesheet_periods/migration.sql` (new); `packages/db/prisma/schema.prisma` (add `TimesheetPeriod` model + `User` back-relation) | — | Table + indexes + Prisma model. |
| **L2 shared-errors** | `packages/shared/src/errors/index.ts` (add `PERIOD_LOCKED` + `PeriodLockedError`) | — | New domain error. Tiny; can fold into L3 if the orchestrator prefers fewer lanes. |
| **L3 backend** | `apps/api/src/time-entries/time-entries.controller.ts` (submit route + `assertPeriodWritable` in create/PATCH/start/switch); `apps/api/src/approvals/approvals.controller.ts` (add `recomputePeriod` hook to manager/final/admin-unlock); a new `apps/api/src/time-entries/period.service.ts` (or `timesheet-periods/`) for `resolveWeek`/`recomputePeriod`/`assertPeriodWritable`; new `apps/api/src/timesheet-periods/` controller for the GET(s) | L1, L2 | Submit, enforcement, recompute, read. |
| **L4 api-designer** | `03-api-design/openapi.yaml`; `tests/contract/src/contract-spec.ts` (move submit out of `KNOWN_ROUTE_GAP`; add periods ops) | L3 shapes | Spec + contract reconciliation. |
| **L5 frontend** | `apps/web/app/timesheets/page.tsx` (submit already wired — verify against the now-real route; surface `PERIOD_LOCKED`); `apps/web/src/lib/api-client.ts` (`friendlyErrorMessages.PERIOD_LOCKED`); optional "week submitted/locked" banner from the new GET | L3, L4 | UX for submit-week + lock messaging. |
| **L6 tests** | `apps/api/test/**` (e2e/integration); `tests/e2e/specs/**` | L3 | See test plan. |

Sequencing: L1+L2 first (no deps) → L3 → L4 (needs L3 shapes) ∥ L5/L6. L4 and L5 can overlap once L3's
shapes are frozen.

### Test plan

- **Period lifecycle:** submit-week creates a `submitted` period + flips draft→submitted + history rows;
  manager-approve all → period `manager_approved`; final-approve all → period `final_approved`; reject →
  period `rejected` then writes allowed again.
- **`PERIOD_LOCKED` at each enforcement point:** createManual into a submitted week → 409; PATCH-move a
  draft entry's `start_at` INTO a submitted week → 409; PATCH within an open week → 200; start/switch
  when current week already submitted → 409.
- **Future-dating invariant:** create/PATCH into an empty future week → 200 (FEAT-001 leave/holiday case
  preserved). Empty week never locked.
- **Boundary entry:** Sun-23:00→Mon-01:00 entry buckets to its `start_at`'s week; a lock on the start
  week blocks it, the adjacent week does not.
- **stage1≠stage2 on the path to period approval:** final-approve by the same actor who did stage-1 →
  `RBAC_FORBIDDEN`, period stays `manager_approved` (recompute does not advance on a failed transition).
- **Admin-unlock reopens the period:** admin-unlock one entry of a `final_approved` week → period
  recomputes to `open`, `reopened_at` set, subsequent createManual into that week → 200.
- **Partial week:** submit a week with 5 entries while 1 is `running` → 5 submitted, running skipped,
  period `submitted` (running excluded from rollup); a later draft added… is blocked (week is locked).
- **TZ correctness:** a user in `Pacific/Auckland` vs `Europe/Amsterdam` — same UTC instant lands in
  different ISO-weeks; lock keys on the *owner's* TZ.
- **Regression:** existing entry-level `ENTRY_LOCKED` on PATCH/DELETE still fires first; the two-stage
  approval e2e (`tests/e2e/specs/approvals.spec.ts`) stays green; contract suite green after the
  `KNOWN_ROUTE_GAP` removal.

---

## Decision: per-entry submit vs period-level submit

**Decision: period-level submit, delivered through the existing per-entry route
`POST /v1/time-entries/{entry_id}/submit` with `scope=week`** (which the openapi already specs and the FE
already calls). Reasoning, grounded in code:

1. **The FE already commits to this shape** (`timesheets/page.tsx:61-71` sends `{scope:'week'}` against
   "any draft entry in the week"). Inventing a new `POST /v1/timesheet-periods/{iso_week}/submit` would
   orphan working FE code and re-open the contract that INC-004 pinned. The cheapest coherent move is to
   *make the route the FE already calls real*.
2. **The user-facing unit is the week** ("submit the week → approve the week → week is locked"), so the
   semantics are period-level even though the URL carries an entry id. `scope=week` is exactly that:
   "submit the period this entry belongs to." We get period-level submit *behavior* with zero new URL.
3. **`scope=entry` remains available** for a future single-entry submit without another endpoint.

What we trade away: a "purer" `/v1/timesheet-periods/.../submit` URL. Acceptable — the entry-anchored
route is already specced, already called, and `scope=week` makes the period the real unit. The KNOWN_ROUTE_GAP
is closed rather than superseded.

---

## 7. Risks & open questions (for the architecture-approval gate)

1. **TOCTOU race (lock SELECT → INSERT).** A parallel submit between `assertPeriodWritable` and the
   create/PATCH could let one write slip into a just-locked week. *Mitigation:* low severity (harm window
   tiny, next edit re-checks; mirrors the existing `te_no_overlap` app-precheck tolerance). *Hardening
   (deferred):* a `BEFORE INSERT/UPDATE` DB trigger on `time_entries` that re-checks the period — the
   Option-F-grade fix. **Open question:** ship the trigger now or track it? Recommend track.
2. **Recompute scope on big weeks.** `recomputePeriod` re-aggregates a week's entries after every
   approval batch. A user's week is tiny (≤ tens of entries) and `te_user_status_start_idx` covers it —
   negligible. No concern; noted for completeness.
3. **Cross-week PATCH double-recompute.** Moving an entry from week A to week B can affect *both*
   periods' rollups (A loses an entry, B gains one). v1: the PATCH-move into a locked B is *rejected*
   before any move, so B never needs recompute; A only relaxes (an entry left). **Open question:** do we
   recompute A on a successful within-allowed move? Recommend yes, cheaply, in the same tx — flagged for
   the api/backend lanes.
4. **Admin reopen ergonomics for fully-approved weeks (§5).** Reopening a `final_approved` week is N
   per-entry admin-unlock calls today. **Open question for the orchestrator:** is a thin "unlock week"
   convenience (loops existing per-entry unlock, same audit, no new authority) in scope for FEAT-002, or
   a tracked follow-up? Recommend follow-up (keeps D4's smallest surface).
5. **DELETE into a locked week (§5).** Left unchanged per D4. **Open question:** do reviewers want DELETE
   of a `draft` entry inside a locked week blocked too? Recommend no (removing work ≠ undermining an
   approved figure), but it is a one-line addition if the gate disagrees.
6. **Period row for an all-rejected/empty week.** Rollup may `DELETE` the row or leave it `open`/`rejected`.
   Recommend: keep the row at `rejected`/`open` (never auto-delete) so `submitted_at`/`reopened_at`
   history survives for audit. **Open question:** confirm we never hard-delete period rows. Recommend keep.
7. **`scope=entry` self-submit + the running entry.** A `running` entry cannot be submitted; submit must
   skip it (not error). Pinned as a test; flagged so the backend lane doesn't 500 on it.
