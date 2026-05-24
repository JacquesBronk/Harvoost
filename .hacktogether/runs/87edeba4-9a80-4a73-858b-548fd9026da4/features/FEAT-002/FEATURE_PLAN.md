# Feature FEAT-002 — Period/timesheet approval locking (GitHub #6)

Run: 87edeba4-9a80-4a73-858b-548fd9026da4 · Date: 2026-05-24 · Flow: feature loop (full gates)
Author: product-analyst (code-grounded design plan — decision-ready, no app code written)

## Reporter description (verbatim)
> There is no week/period-level "approved" lock. Approval is tracked **per entry**
> (`draft → submitted → manager_approved → final_approved`). Today a user can create a manual
> entry — or back-date one — into a period whose entries have already been submitted/approved,
> provided the new entry doesn't overlap an existing one (the only guard `createManual` applies
> is `end_at > start_at`, `≤24h`, and the GiST no-overlap check). This can quietly undermine an
> already-approved timesheet. `PATCH /v1/time-entries/:id` already blocks edits when an entry is
> in a locked status (`LOCKED_STATUSES = {submitted, manager_approved, final_approved}`), but
> **creation/back-dating into a locked period is not checked**. Introduce a period/timesheet
> approval-lock concept so that creating, back-dating, or editing entries **into an approved
> period** is rejected with a clear 4xx (e.g. `VALIDATION_FAILED` / a dedicated `PERIOD_LOCKED`).
> Future-dating remains allowed (FEAT-001 leave / public-holiday case). Tests + a clear envelope.

---

## Analysis (think-before-act)

**1. What is the user actually trying to accomplish?** Protect the integrity of an
already-reviewed timesheet. The real harm is that an approved week can be *retroactively altered*
by inserting (or back-dating, or PATCH-moving) an entry into that week, after a manager/finance
reviewer has already signed off on what they saw. The guard must be on the *write into a closed
period*, not on the period concept for its own sake. The narrowest faithful reading: "if a user
already submitted/got-approved work in week W, they must not be able to add or relocate work into
week W without an admin re-opening it."

**2. What already exists in the codebase?** A surprising amount — this is mostly a *gap-closing*
feature, not a greenfield one:
- `time-entries.controller.ts:74` — `LOCKED_STATUSES = {submitted, manager_approved, final_approved}`
  already exists and is the canonical per-entry lock set.
- `time-entries.controller.ts:355` (PATCH) and `:403` (DELETE) **already throw `EntryLockedError`**
  when the *target entry's own status* is locked. **Confirmed in code.**
- `EntryLockedError` → `ENTRY_LOCKED` (409) is a fully-wired domain error with the
  `{ code, message, details: { entry_id, status } }` envelope (`packages/shared/src/errors/index.ts:52`),
  surfaced by the global `HttpExceptionFilter` (`apps/api/src/common/filters/http-exception.filter.ts:23`).
- The two-stage approval state machine is live in `apps/api/src/approvals/approvals.controller.ts`:
  `submitted → manager_approved` (`managerAction`), `manager_approved → final_approved`
  (`finalAction`, with a two-actor-separation invariant), and crucially an **existing admin override**:
  `POST /v1/approvals/admin-unlock/:entryId` (`:135`) which flips one entry back to `draft` with an
  audited, ≥20-char reason. There is **no period-level unlock** — admin override is per-entry today.
- The `time_entry_state_history` table records every transition with actor + reason (good audit base).
- `User.timezone` exists (default `Europe/Amsterdam`, `schema.prisma:40`) and `OrgSetting.defaultTimezone`
  exists — so a per-user-timezone ISO-week computation has the data it needs.

**3. What does NOT exist (the actual gap + the trap):**
- **No period / timesheet entity.** No `timesheet_periods`, no `pay_periods`, nothing. The grep of
  `schema.prisma` confirms 28 tables and none model a period. Approval is *purely per-entry.*
- **No `POST /v1/time-entries/{id}/submit` route.** It is declared in `openapi.yaml:1277` (scope
  `entry`/`week`) **but no controller registers it** — it is on the contract allowlist as
  `KNOWN_ROUTE_GAP` (`tests/contract/src/contract-spec.ts:189-195`, from INC-004). So today entries
  only reach `submitted` via direct DB seeding / the mock API — there is no production user path to
  submit. **This matters for scope:** a "fuller" period feature naturally wants submit wired first.
- **The enforcement holes (the bug):** `createManual` (`:300`) applies only `end_at > start_at`,
  `≤24h`, and the GiST overlap pre-check — **no period/lock check.** Back-dated `POST /start` and
  `POST /switch` insert at `NOW()` so they cannot *currently* back-date (see §3 — there is a subtle
  gap to address). And **PATCH can MOVE an entry's `start_at`/`end_at` into a locked period** even
  though the entry's *own* status is `draft` — the existing lock only checks the entry's status, not
  the destination period. This is a real, currently-unguarded hole.

**4. Most likely ways an implementor misreads this:**
- **Conflating "the entry is locked" with "the period is locked."** PATCH/DELETE already check the
  former. The new check is about the *destination week*, which may contain *other* locked entries
  even when the entry being written is itself `draft`. Both checks must coexist.
- **Assuming `start`/`switch` can back-date.** They insert `start_at = NOW()` (`:175`, `:256`), so a
  literal back-date is impossible *through those routes today*. The issue's "back-dated start/switch"
  language is forward-looking; the only true back-dating vector today is `createManual` and a
  PATCH that moves `start_at`. The plan still adds the guard to `start`/`switch` defensively (cheap,
  future-proof) but the *load-bearing* fixes are `createManual` and PATCH-move.
- **Locking the wrong scope (UTC week vs user-TZ week).** "Period" must be computed in the user's
  IANA timezone or a Sunday-night entry lands in the wrong week. `User.timezone` is the source.
- **Breaking future-dating.** FEAT-001 shipped free future-dating for leave/public-holiday entries
  (FEAT-001 gate (a) decision #3). The lock must key on *whether the destination period already has a
  locked entry*, NOT on "is this date in the past" — so an empty future week is never locked.

---

## 1. Scope assessment (REQUIRED)

| Question | Verdict (Option L — recommended) | Verdict (Option F — fuller) |
|---|---|---|
| **Structural change (new table/entity)?** | **NO** — reuses `LOCKED_STATUSES` + existing `time_entries` rows; "period locked" is a *query*, not a stored entity. | **YES** — new `timesheet_periods` (or `timesheet_submissions`) entity + its lifecycle. |
| **API contract change?** | **YES, additive only** — one new error code `PERIOD_LOCKED` added to the `ErrorCode` enum in `packages/shared/src/errors/index.ts` and the `openapi.yaml` `ErrorCode` schema (`:3092`). **No new endpoint, no new request/response shape** — enforcement is internal validation inside existing POST/PATCH handlers. | **YES, larger** — wire `POST /v1/time-entries/{id}/submit` (close the KNOWN_ROUTE_GAP), likely new period-submit/approve endpoints, new response schemas. |
| **Migration?** | **NO** — no schema change. (Optional: a covering index `time_entries(user_id, status, start_at)` already exists at `schema.prisma:284`, so even the lock query is already indexed.) | **YES** — create-table migration + backfill + the period FK on `time_entries` if entries are tied to a period row. |

**Headline:** Option L is a **no-table, no-migration, additive-API** change. Option F is a
multi-table, multi-endpoint, migration-bearing change that pulls in the deferred submit workflow.

---

## 2. Definition of "period approved" — options + recommendation

### Period granularity (applies to both options)
**Recommended: per-user, per-ISO-week, computed in the user's IANA timezone** (`User.timezone`,
falling back to `OrgSetting.defaultTimezone`). ISO-8601 week (Mon–Sun) is the natural unit because:
the system already speaks ISO weeks everywhere (`MoodWeeklyAggregate.isoYear/isoWeek`
`schema.prisma:328`; the openapi submit op already defines week-scope as "same ISO week in the
requester's TZ" `:1285`; INC-007 drill-ins send the current ISO week). A configurable pay-period
would need a new config surface and is out of proportion to the bug. **`[ASSUMED: ISO-week
granularity, user-TZ — confirm at gate (a) decision D1.]`**

The week of a candidate `start_at` = `(iso_year, iso_week)` of `start_at` rendered in the user's TZ.
Computed in SQL via `date_trunc('week', (start_at AT TIME ZONE <user_tz>))` and its `+ INTERVAL '7
days'` upper bound (half-open `[)`), so all comparisons stay in the same TZ frame.

### Option L — Lighter: "period locked = ≥1 locked-status entry in that user's week" (RECOMMENDED)
A week W is **locked for user U** iff `time_entries` contains ≥1 row with `user_id = U`,
`status ∈ LOCKED_STATUSES`, and `start_at` falling in week W (user-TZ). Enforced by a single
pre-insert / pre-update `SELECT 1 ... LIMIT 1`. No new entity.

- **What gets locked:** *new writes* (create / back-date / PATCH-move) of an entry whose `start_at`
  lands in a week that already has a submitted-or-approved entry for that user.
- **Future-dating stays allowed:** an empty future week has zero locked entries → never locked.
  A future leave/holiday week only locks itself once something in it is submitted/approved.
- **Interaction with two-stage approval:** zero new state. The existing `submitted →
  manager_approved → final_approved` machine is the *source of truth* for "is this week closed."
  A `rejected` entry is NOT in `LOCKED_STATUSES`, so a rejected week correctly re-opens for fixes.
- **Admin override:** reuse the **existing** per-entry `POST /v1/approvals/admin-unlock/:entryId`.
  Flipping the locking entries back to `draft` empties the week's locked-set → the week auto-unlocks.
  No new override endpoint needed for v1. `[ASSUMED: per-entry admin-unlock is sufficient; a
  period-level "unlock week" is out of scope — confirm D4.]`
- **Edge cases:**
  - *Entry spanning a period boundary* (Sun 23:00 → Mon 01:00): lock keys on **`start_at`'s week**
    only (single, deterministic, matches how the submit op + list filter already bucket by
    `start_at`). A cross-midnight entry belongs to its start week. Documented, test-pinned.
  - *Leave / public-holiday future entries (FEAT-001):* unaffected — future weeks have no locked
    entries. A holiday entry *in an already-approved past week* is correctly blocked (that is the
    desired behavior — you can't add holiday time to a signed-off week).
  - *PATCH that MOVES an entry into a locked week:* the entry's own status is `draft` (else the
    existing `ENTRY_LOCKED` fires first), but the **new** `start_at`/`end_at` may land in a week with
    other locked entries → must throw `PERIOD_LOCKED`. **This is the most important new check** and
    must be evaluated against the *post-edit* week, excluding the row itself.
  - *Self-collision:* the lock query must EXCLUDE the candidate entry's own id on PATCH (an entry
    can't lock itself out of its own week).
  - *Concurrency:* a TOCTOU window exists between the lock `SELECT` and the `INSERT` if a parallel
    submit lands. Acceptable for v1 (the harm window is tiny and the next edit is re-checked); the
    existing GiST/overlap guard already shows the codebase tolerates app-level pre-checks. Flag as a
    known low-severity race in the risk table; a DB trigger is the Option-F-grade hardening.

### Option F — Fuller: real period entity + submit/approve workflow
Introduce `timesheet_periods` (`user_id, iso_year, iso_week, status, submitted_at, approved_at, ...`),
wire `POST /v1/time-entries/{id}/submit` (close the KNOWN_ROUTE_GAP) to create/advance the period
row, lock at the period level (status `submitted`/`approved` on the period row), and add a
period-level approve + admin "re-open week."

- **What gets locked:** writes into any week whose `timesheet_periods` row is in a closed status.
- **Future-dating:** same principle — no period row (or a `draft` one) ⇒ open.
- **Interaction with approval flow:** *larger* — the per-entry status machine and the per-period
  status must be kept consistent (does approving the last entry approve the period? does a new entry
  re-open it?). This is genuine new domain design.
- **Admin override:** a new period-level "re-open week" endpoint (the per-entry admin-unlock no
  longer maps cleanly).
- **Blast radius (honest):** new table + migration + backfill; new/changed endpoints (`submit`,
  period-approve, re-open); new response schemas in openapi; approvals controller changes; an
  api-designer pass for the new ops; substantially more tests. This is a *multi-lane* feature, not a
  gap-fix. It is the right long-term design but is disproportionate to issue #6 as filed (#6 asks to
  *stop the back-date hole*, and even lists `VALIDATION_FAILED`/`PERIOD_LOCKED` as the deliverable —
  i.e. it scopes itself to the lighter lock).

### Recommendation
**Option L (lighter).** It closes the exact hole #6 describes with no table, no migration, and one
additive error code, and it is *forward-compatible* with Option F (when submit/period entities land
later, the lock predicate is swapped from "≥1 locked entry in week" to "period row is closed" with
no change to the enforcement points or error envelope). Treat Option F as the tracked follow-up that
the submit-workflow gap (INC-004 KNOWN_ROUTE_GAP) will eventually pull in.

---

## 3. Enforcement points (precise)

"Back-dated" / "into a locked period" is defined as: **the candidate entry's `start_at`, rendered in
the user's TZ, falls in an ISO week that is locked for that user (Option L predicate).** It is NOT
defined as "before today" — that would wrongly block edits within an *open* current/past week and
wrongly allow inserts into an approved week if today happens to be inside it.

| Handler | Location | Today | Required change |
|---|---|---|---|
| `createManual` (`POST /v1/time-entries`) | `:300` | only `end>start`, `≤24h`, overlap | **ADD** `PERIOD_LOCKED` check on `start_at`'s week before insert. **Load-bearing.** |
| `PATCH /v1/time-entries/:id` | `:337` | checks entry's OWN status (`ENTRY_LOCKED` `:355`) | **ADD** a destination-period check: if the patch changes `start_at`/`end_at`, evaluate the *new* week (excluding self) for locked entries → `PERIOD_LOCKED`. **Load-bearing — the PATCH-move hole.** Keep the existing own-status `ENTRY_LOCKED` check (it fires first). |
| `POST /v1/time-entries/start` | `:151` | inserts `start_at = NOW()` | **ADD defensively.** Cannot back-date today (always `NOW()`), so the check is a no-op in practice but future-proofs the handler and satisfies the issue's literal ask. Low cost. |
| `POST /v1/time-entries/switch` | `:235` | inserts `start_at = NOW()` | **ADD defensively**, same rationale as `start`. |
| `DELETE /v1/time-entries/:id` | `:394` | checks entry's OWN status (`ENTRY_LOCKED` `:403`) | **No change** — a delete of a `draft` entry inside an otherwise-locked week is arguably allowed (it removes work, doesn't undermine an approved figure) AND a delete of a locked entry is already blocked. `[ASSUMED: DELETE stays as-is — confirm D3 if the orchestrator wants deletes of draft entries in a locked week blocked too.]` |

**Confirmation of the issue's claim:** PATCH (`:355`) and DELETE (`:403`) **are** already covered by
`EntryLockedError` for the *entry's own status*. The previously-unstated gap is the **PATCH-move into
a locked week**, which the own-status check does NOT cover — this plan closes it.

**Future-dating invariant (must be a test):** creating/patching into an *empty* future week always
succeeds; only a week that already contains a locked-status entry for that user rejects.

---

## 4. Error envelope

**Recommendation: a dedicated `PERIOD_LOCKED` code** (409), mirroring the existing `ENTRY_LOCKED`
pattern exactly. Reusing `VALIDATION_FAILED` (400) would be lossy — the client cannot distinguish "you
sent garbage" from "this week is sealed," and the FE wants to render a distinct "this week is approved,
contact your manager/admin to re-open" message (parallel to how it already special-cases
`ENTRY_LOCKED`, e.g. `tests/e2e/specs/approvals.spec.ts:203`). The cost is one additive enum entry in
two places — non-breaking (the contract test does not assert the enum, confirmed in
`tests/contract/src/contract.test.ts`).

Proposed new domain error (to add to `packages/shared/src/errors/index.ts`, alongside `EntryLockedError`):

```
PERIOD_LOCKED: 'PERIOD_LOCKED'   // add to ErrorCode enum

class PeriodLockedError extends DomainError {
  constructor(isoYear: number, isoWeek: number, lockingStatus: string) {
    super(
      ErrorCode.PERIOD_LOCKED,
      `Cannot write into week ${isoYear}-W${isoWeek} — it has already been ${lockingStatus} and is locked.`,
      409,
      { iso_year: isoYear, iso_week: isoWeek, locking_status: lockingStatus },
    );
    this.name = 'PeriodLockedError';
  }
}
```

Wire status (409) is consistent with `ENTRY_LOCKED` (both are "the resource is in a state that
forbids this write"). The global filter already maps any `DomainError` to `{ code, message, details }`
(`http-exception.filter.ts:23`) — no filter change needed. openapi: add `PERIOD_LOCKED` to the
`ErrorCode` enum (`:3092`) and a 409 response example on the affected POST/PATCH ops.

---

## 5. Recommended approach + open decisions for gate (a)

**Recommended approach:** Ship **Option L** — a no-table, no-migration period lock that reuses
`LOCKED_STATUSES`, enforced as an internal pre-write check in `createManual` and `PATCH` (load-bearing)
plus defensively in `start`/`switch`, surfaced with a new additive **`PERIOD_LOCKED`** (409) domain
error. Granularity = per-user ISO-week in the user's TZ. Admin override = the existing per-entry
`admin-unlock`. Tests pin: the create/PATCH-move rejection, the future-week-stays-open invariant, the
boundary-entry rule, and self-exclusion on PATCH.

**Decisions for the orchestrator to put to the user (≤2 rounds, framed as choices):**

- **D1 — Period granularity.** (a) Per-user **ISO week** in the user's TZ *(recommended)*; or
  (b) per-user **pay-period** (requires a new config surface → larger). → Recommend (a).
- **D2 — Lighter vs fuller.** (a) **Option L** — reuse per-entry locked statuses, no table/migration,
  ships now *(recommended)*; or (b) **Option F** — new period entity + wire the deferred
  `POST .../submit` workflow + period-level approve/re-open (multi-lane, migration, api-designer pass).
  → Recommend (a), with Option F tracked as the follow-up tied to the submit KNOWN_ROUTE_GAP.
- **D3 — Error code.** (a) New dedicated **`PERIOD_LOCKED`** 409 *(recommended)*; or
  (b) reuse `VALIDATION_FAILED` 400 (lossy for the FE). → Recommend (a).
- **D4 — Admin override + DELETE scope.** (a) Reuse the **existing per-entry** `admin-unlock`
  (unlocking the locking entries auto-reopens the week) and **leave DELETE unchanged** *(recommended,
  smallest)*; or (b) also add a period-level "re-open week" override and/or block DELETE of draft
  entries inside a locked week (more surface). → Recommend (a).

---

## Out of scope (explicitly deferred)
- **A real `timesheet_periods` entity / Option F** — deferred follow-up, naturally bundled with the
  submit-workflow gap below.
- **Wiring `POST /v1/time-entries/{id}/submit`** (the INC-004 `KNOWN_ROUTE_GAP`,
  `tests/contract/src/contract-spec.ts:189`) — Option L does not require it; it remains a separate
  latent gap. (Option L locks based on whatever path *does* reach a locked status today, e.g. the
  approvals controller / seeding.)
- **A period-level approve endpoint or "unlock week" override** — Option L reuses per-entry
  admin-unlock; period-level re-open is Option F territory.
- **Changing the two-stage approval state machine** in `approvals.controller.ts` — untouched.
- **Reconciling the `switch` spec↔controller field drift** (`new_project_id` vs `project_id`) — a
  pre-existing FEAT-001-flagged item, not part of #6.
- **Any FE UI for the lock** beyond surfacing the `PERIOD_LOCKED` message via the existing
  `describeError`/toast path (mirrors how `ENTRY_LOCKED` is already surfaced).

## [ASSUMED] tags (carry to the Decision log if unchallenged after gate (a))
- `[ASSUMED: ISO-week, user-TZ granularity]` (D1)
- `[ASSUMED: Option L — no new entity/migration]` (D2)
- `[ASSUMED: dedicated PERIOD_LOCKED 409 code]` (D3)
- `[ASSUMED: reuse existing per-entry admin-unlock; DELETE unchanged]` (D4)
- `[ASSUMED: boundary entry buckets by start_at's week]` (§2 edge case)
