# FEAT-001 — UX / Design decision doc (HITL gate (a))

This is the doc you review before we build. Two decisions need your pick (§1 task selection,
§2 placement); the rest (§3–§6) are recommendations with mocks. Each has a recommendation so
you can approve the defaults in under a minute, or override any single one.

---

## 1. Task selection — THE headline decision

Starting a timer can semantically take a **project** and a **task**. But the task endpoints
(`GET/POST /v1/projects/{id}/tasks`) are **stubbed / allowlisted** — there is no real backend
implementation behind them.

| Option | What ships | Cost / blast radius |
|---|---|---|
| **(i) Project-only start (RECOMMENDED)** | Pick a project → start. No task field. | FE-only wiring. Unblocks clock-in today. `task_id` is optional on every controller schema, so adding tasks later is non-breaking. |
| (ii) Project + task | Also build real `GET/POST /v1/projects/{id}/tasks` | Backend scope creep: new controller logic, DTOs/Zod, spec ops, migrations(?), tests + the contract test must add the ops. Turns a FE-wiring task into a backend feature. |

**RECOMMENDATION: (i) project-only.** It satisfies the actual need (make clock-in reachable)
with the smallest, safest change; tasks become a clean follow-up once the endpoints are real.

---

## 2. Start-control placement

The issue asks for the start affordance in **both** `/timesheets` and `TimerBar`. The shared
logic lives in one `startTimer` lib fn / `useStartTimer` hook that both surfaces call, so "both"
is **not** double the work — it is one code path rendered in two places.

### Option A — Inline on /timesheets only
```
 /timesheets ─────────────────────────────────────────────
  Timesheets                         [Prev] [Next] [Submit week]
 ┌──────────────────────────────────────────────────────────┐
 │  Start a timer                                            │
 │  ┌───────────────────────────┐                           │
 │  │ Project ▾  (Acme Website) │   [▶ Start]                │
 │  └───────────────────────────┘                           │
 └──────────────────────────────────────────────────────────┘
  Week of 18 May                                  32.0h total
  Date    Project    Task   Notes        Hours   Status
  ...
```
Idle TimerBar keeps showing "No active timer" (but with the dead link removed). Start lives
only on /timesheets.

### Option B — TimerBar dropdown only
```
 (global bar, idle state)
 ┌──────────────────────────────────────────────────────────┐
 │ ▶ No active timer            [▶ Start timer ▾]            │
 └──────────────────────────────────────────────────────────┘
        click ▾ ─────────────▼
        ┌──────────────────────────────┐
        │ Project  ▾  (Acme Website)   │
        │            [▶ Start]         │
        └──────────────────────────────┘
```
/timesheets gets no inline control; start is reachable from any page via the bar.

### Option C — Both (RECOMMENDED — the literal ask)
```
 (global bar, idle)                         /timesheets
 ┌────────────────────────────┐    ┌────────────────────────────────┐
 │ ▶ No active timer  [Start▾]│    │ Start a timer                  │
 └────────────────────────────┘    │ [Project ▾ Acme] [▶ Start]     │
        (dropdown picker)           └────────────────────────────────┘
        ─ shares startTimer() ──────────────┘ same hook, two render sites
```
Inline primary control on /timesheets (most discoverable for clock-in) **plus** a real start
affordance in the bar (reachable from anywhere). Both call the one `useStartTimer` hook.

**RECOMMENDATION: (C).** It is exactly what #5 asks for, kills the dead-link dead end on every
page, and costs little beyond (A) because the logic is shared. If you want the smallest possible
change, (A) is the fallback (start from /timesheets, bar just loses the dead link).

---

## 3. Manual "New entry" UX

Trigger: a "New entry" button on /timesheets (next to Submit week, or under the Start control).
Opens a small form/modal.

```
 ┌─ New time entry ─────────────────────────────┐
 │ Project *   [ Acme Website            ▾ ]    │
 │ Start *     [ 2026-05-23  09:00 ]            │
 │ End *       [ 2026-05-23  11:30 ]            │
 │ Notes       [ Sprint planning            ]   │
 │                                              │
 │   2.5h            [ Cancel ]  [ Save entry ] │
 └──────────────────────────────────────────────┘
```
- **Fields:** project (required), start datetime (required), end datetime (required), notes
  (optional). No task (per §1).
- **Validation (client-side, before any API call):**
  - end **>** start → else block + "End must be after start".
  - duration ≤ 24h → else block (mirrors the controller's 24h cap, `time-entries.controller.ts:309`).
  - Future entries: `[ASSUMED: ALLOWED]` — the controller does not reject future timestamps, so
    the FE will not either; the only hard server rule is no-overlap + ≤24h. (Override at gate if
    you want future entries blocked client-side.)
- **Submit:** `POST /v1/time-entries`, body `{ project_id, start_at, end_at, notes? }`, datetimes
  as ISO-8601 with the viewer's offset. **No Idempotency-Key** (the manual-create route does not
  take one, `time-entries.controller.ts:300-335`).
- **After create:** invalidate the week query; the new `draft` entry appears in the week list for
  the week containing its `start_at`. On 409 (overlap) / 422, show the server message via the
  existing toast and keep the form open.

**RECOMMENDATION:** modal triggered from a "New entry" button on /timesheets; project-only;
client-side end>start + ≤24h checks; future entries allowed.

---

## 4. Switch UX (change project without stopping)

Lives on the **running** TimerBar (the bar already renders project name + elapsed when running,
`TimerBar.tsx:88-120`). Add a "Switch" affordance next to Stop.

```
 (global bar, running)
 ┌──────────────────────────────────────────────────────────┐
 │ ● Running  Acme Website  00:42:15      [⇄ Switch] [■ Stop]│
 └──────────────────────────────────────────────────────────┘
        click ⇄ ─────────▼
        ┌──────────────────────────────┐
        │ Switch to: [ Internal Ops ▾ ]│
        │            [⇄ Switch]        │
        └──────────────────────────────┘
```
- Picks a new project → `POST /v1/time-entries/switch`, header `Idempotency-Key`, body
  **`{ project_id }`** — the controller's field name (`SwitchSchema`, `time-entries.controller.ts:34`).
  **NOT** `new_project_id` (that is what the spec example shows, but the live route validates
  `project_id` — see §6 and FEATURE_PLAN Analysis #4).
- Elapsed time does not reset to a stopped state; server atomically closes the old entry to
  `draft` and opens a new `running` one. Bar shows the new project on the next poll.
- This also resolves the Story-1 "already running" case: when a timer is running, the start
  control surfaces "Switch" instead of firing a start that would 409.

**RECOMMENDATION:** Switch button on the running bar → inline project dropdown; reuse the same
picker component as Start.

---

## 5. Idempotency-Key wiring

- **Existing proven pattern** (cite): `TimerBar`'s stop call —
  `apiFetch('/v1/time-entries/stop', { method: 'POST', headers: { 'Idempotency-Key': newIdempotencyKey() } })`
  (`apps/web/src/components/TimerBar.tsx:50-55`). `newIdempotencyKey()` returns
  `crypto.randomUUID()` (`apps/web/src/lib/api-client.ts:168-174`).
- **start** and **switch** mirror this exactly: a fresh key generated per submit, attached as the
  `Idempotency-Key` header. The header is REQUIRED on these routes — the controller throws
  `ValidationFailedError('Idempotency-Key header required.')` without it
  (`time-entries.controller.ts:157,241`). The spec marks the param required too (openapi.yaml:2867-2874).
- **manual create** attaches **NO** key — `@Post()` createManual neither reads nor requires the
  header (`time-entries.controller.ts:300-335`).
- Centralised in the new `time-entries.ts` lib so all three surfaces (inline / bar / switch) share
  one implementation.

---

## 6. Contract-test impact — FE-only, no api-designer needed

| New apiFetch path | In openapi.yaml? | Registered route? | Verdict |
|---|---|---|---|
| `POST /v1/time-entries/start` | yes (openapi.yaml:1087) | yes (controller:151) | spec✓ route✓ |
| `POST /v1/time-entries/switch` | yes (openapi.yaml:1177) | yes (controller:235) | spec✓ route✓ |
| `POST /v1/time-entries` (manual) | yes (openapi.yaml:1010) | yes (controller:300) | spec✓ route✓ |
| `GET /v1/projects` (picker) | yes | yes (controller:30) | already wired elsewhere |

**Every new FE path maps to an existing spec op + real route, so `@harvoost/contract` stays
122/122 with NO api-designer step.** The contract test checks **query keys** (not body keys)
against the spec, and none of these POSTs add query params — so they introduce no new param drift.

**Two divergences to flag (they do NOT fail the contract test, but the build must heed them):**
1. **`switch` body field names.** Spec `SwitchTimeEntryRequest` = `new_project_id`/`new_task_id`/
   `new_notes` (openapi.yaml:3394-3401); live controller validates `project_id`/`task_id`/`notes`
   (controller:34-38). **FE must send `project_id`.** Building to the spec would 422 live.
2. **`running` / `start` response envelopes.** `GET /running` returns `{ data }`
   (controller:148) but the FE type/`TimerBar` read `.running`/`.today_total_hours`
   (TimerBar.tsx:33,108) — so a started timer would NOT appear in the bar today. The build MUST
   reconcile the FE running-read to `{ data }`. `start`/`switch` return the entry **unwrapped**
   (controller:198,277), unlike `list`/`running`. None of this is a spec/contract change — it is
   FE read-shape correction inside this feature.

Reconciling the spec's switch schema to the controller is an OPTIONAL separate api-designer
follow-up (out of FEAT-001 scope); the FE wires to the controller now.
