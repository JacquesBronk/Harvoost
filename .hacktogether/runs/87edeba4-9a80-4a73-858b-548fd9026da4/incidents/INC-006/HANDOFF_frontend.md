---
phase: 04-build
agent: frontend-dev
started: 2026-05-24
finished: 2026-05-24
status: complete
---

# Summary
Fixed the FRONTEND lane of INC-006 (#7): `/admin/users` crashed into the React
error boundary on load because the page read `user.roles` UNGUARDED in four
places while `GET /v1/users` omitted the field, so `user.roles.length` threw
`TypeError: Cannot read properties of undefined (reading 'length')`. Added a
defensive guard (belt-and-suspenders, even after the backend fix that now
returns `roles`) by extracting the role-render + editor-seed logic into a small,
testable helper module and routing all four read sites through it. Rendered
behavior is identical when `roles` is present; a missing/empty field degrades to
"No roles" instead of crashing the route. The `User.roles` type stays
`Role[]` required (backend always returns it now); the `?? []` guard lives at the
read sites only. Added a hermetic vitest regression. Stayed entirely in
`apps/web/*` — no `apps/api/*`, no `openapi.yaml`, no `query-client.ts`, no
`.github/`.

# Files touched
- apps/web/app/admin/users/roles-cell.tsx (new) — `rolesOf()` / `roleSet()` / `<RolesCell>` helpers; the single place the `?? []` guard lives.
- apps/web/app/admin/users/page.tsx (modified) — replaced 4 unguarded `user.roles` sites with the guarded helpers; added the helper import.
- apps/web/__tests__/inc006-users-roles-guard.test.ts (new) — 11 hermetic tests.

# Guard sites (all 4 from the report, now guarded)
- page.tsx ~:138 — `submitRolesEditor` diff seed `new Set(user.roles)` → `roleSet(user)` (was unguarded; would also crash on save with a drifted row).
- page.tsx ~:282 — render `user.roles.length === 0` → inside `<RolesCell>` via `rolesOf(user)`.
- page.tsx ~:285 — render `user.roles.map(...)` → inside `<RolesCell>` via `rolesOf(user)`.
- page.tsx ~:314 — "Edit roles" onClick seed `draft: new Set(user.roles)` → `draft: roleSet(user)`.
- Scanned the whole file: no other `.roles` access remains. (Out-of-scope `/v1/auth/me` consumers — settings/page.tsx, AppShell.tsx, rbac.ts, auth.ts — were NOT touched; rbac.ts already guards with `?? []`.)

# What downstream agents need to know
- Cross-lane contract honored: `<RolesCell>` renders `roles: string[]` (one Badge chip per role) when present, and "No roles" when the array is empty OR the field is absent. It survives the backend's pre-fix shape and renders the post-fix shape correctly.
- Decision (for the run Decision log): kept `User.roles: Role[]` REQUIRED in api-types.ts (per task guidance — backend now always returns it). The guard is `?? []` at read sites, not an optional type change. No new dependencies; helper uses the existing `@harvoost/ui` `Badge`.
- Decision: the page component can't render in isolation under the node-env vitest setup (it depends on useScope/useRouter/useQuery/useToast and there's no jsdom or @testing-library). Followed the codebase's established pattern (avatar.test.ts) — extracted the minimal role-rendering helper and tested it with `renderToStaticMarkup`. This keeps the test hermetic and matches existing conventions.
- No regression to INC-001..005 / FEAT-001: did not touch middleware, OIDC, /me backoff, query-client.ts, or timer UI.

# Open questions / unknowns
- None. (Acceptance criteria 1 + 3 are now satisfied frontend-side; criteria 2 + 4 are the backend/contract lanes' responsibility.)

# Verification evidence
- `pnpm --filter @harvoost/web test` → 9 files, 98 passed (baseline 87 + 11 new INC-006 tests). 0 failed.
- `pnpm --filter @harvoost/web typecheck` → clean (tsc --noEmit, no errors).
