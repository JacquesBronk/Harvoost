# Contributing

Local-dev setup, the test layout, and a handful of ground rules. Anything not covered here defers to the [README](./README.md) or the architecture docs under `.hacktogether/runs/<run-id>/02-architecture/`.

## Getting set up

Follow the README's [Quick start](./README.md#quick-start). One-shot bootstrap is `pnpm setup`. Day-to-day, run the API and web in two terminals: `pnpm dev:api` and `pnpm start:web` (after `pnpm build:web` for any web change).

## Branching and commits

- Default branch is `main`. PRs against `main`; no direct push.
- Conventional commit prefixes are encouraged: `feat:`, `fix:`, `chore:`, `refactor:`, `docs:`, `test:`.
- One PR = one logical change. Keep diffs reviewable.

## Code quality gates

Every PR must pass:

```bash
pnpm typecheck      # tsc --noEmit across all 10 packages
pnpm lint           # eslint
pnpm test           # 375 unit + integration tests
pnpm e2e            # hermetic Playwright (no live Keycloak required)
```

Run them locally before pushing. CI runs the same commands.

## Adding a database migration

1. Edit `packages/db/prisma/schema.prisma`.
2. `pnpm --filter @harvoost/db migrate:dev --name <descriptive_name>` — creates a timestamped migration in `packages/db/prisma/migrations/`.
3. Commit both the schema and the generated SQL.
4. The deploy step runs `prisma migrate deploy` against the target DB. Migrations are forward-only — there is no down-migration.

## Adding an API endpoint

1. Add the route to the relevant NestJS module under `apps/api/src/`.
2. Add a Zod schema for request/response under the module's `dto/` folder.
3. Wire the endpoint to `RbacScopeService` if it returns user-anchored data. There is no exception to RBAC enforcement at the data layer.
4. Add tests under `apps/api/test/`. The standard pattern uses `mintTestSession(userId)` to set up an authenticated request — see `apps/api/test/helpers/session.ts`.
5. Update `.hacktogether/runs/<run-id>/03-api-design/openapi.yaml` for any contract change.

## Adding a chatbot tool

1. Add the tool to `packages/shared/src/llm/tools/`.
2. Bind the requesting user's `userId` via the registry's currying pattern (see existing tools). Do NOT take `user_id` from the LLM prompt.
3. Apply `RbacScopeService` inside the tool body. The chatbot's result set must be the same as the dashboard's for an equivalent query.
4. Add the tool to the capability matrix at `packages/shared/src/llm/capabilities.ts`.
5. Add a unit test covering the in-scope case AND the out-of-scope case (out-of-scope must return empty or `not_visible`, never raw data).

## RBAC and security non-negotiables

- Every query that returns user-scoped data MUST go through `RbacScopeService`. There is a custom ESLint rule scaffold for `no-unscoped-prisma-query` (documented; enforcement is a v1.0.1 follow-up).
- Cost rates and billable rates are gated to Admin and Financial Manager roles only. Cost columns must be stripped server-side, not in the UI.
- Mood data: raw entries are visible only to the entry owner; managers see only aggregates with k≥5.
- Audit any state-changing handler via `AuditService.record()`. The HMAC chain is load-bearing — `audit_hash_secret` is set at the connection level inside the transaction wrapper.

## Testing layout

- `apps/api/test/unit/` — service-level unit tests (no DB).
- `apps/api/test/integration/` — Testcontainers-backed Postgres tests.
- `apps/api/test/e2e/` — supertest against a booted Nest module.
- `tests/e2e/` — Playwright suite. Two projects: `chromium-hermetic` (mocked API, default) and `chromium-live` (real Keycloak + API; `pnpm e2e:live`).

## Where things live in the hacktogether SDLC artifacts

The build history lives under `.hacktogether/runs/<run-id>/`:

- `01-intake/` — requirements + interview transcript
- `02-architecture/` — architecture, stack manifest, ADRs
- `03-api-design/` — OpenAPI + design notes
- `04-build/{db,backend,frontend}/HANDOFF.md` — what each lane built
- `05-test/TEST_REPORT.md` — test plan + results
- `06-review/` — code + security review findings
- `07-deploy/{DEPLOY_READINESS,TODO_INVENTORY}.md` — predeploy operator material
- `08-docs/HANDOFF.md` — docs phase handoff
