---
phase: incidents/INC-002
agent: frontend-dev
started: 2026-05-23
finished: 2026-05-23
status: complete
---

# Summary
Implemented the FRONTEND lane of INC-002 (everything inside `apps/web` + the e2e specs that
reference the login button text). Fixed the three-way OIDC contract mismatch on the web side:
the login page now POSTs `{ client_kind: 'web' }` (stops sending the dead `redirect_uri`),
consumes `opaque_state_id` (not `state`) from the `/oidc/login` response, persists it to
`sessionStorage`, and the callback page reads it back and includes it in the `/oidc/callback`
POST body (`{ code, state, opaque_state_id }`) — satisfying the backend's `OidcCallbackSchema`.
Made the login copy IdP-agnostic (ADR-0001) by fetching the new public `GET /v1/auth/idp-info`
endpoint and rendering `display_name` in both the card copy and the button label, with a neutral
non-blocking fallback. Updated the e2e specs/fixtures/docs that matched the old "Continue with
Microsoft" label and taught the hermetic mock-api the new contract (idp-info handler + 201 +
`opaque_state_id`).

# Files touched
- `apps/web/app/login/page.tsx` (modified) — B1+B3+Lane A: `OidcLoginResponse` now `{ authorization_url, opaque_state_id }`; `handleSignIn` POSTs `{ client_kind: 'web' }`, persists `opaque_state_id` to `sessionStorage` before `window.location.assign`; added a non-blocking `useEffect` that fetches `GET /v1/auth/idp-info` and renders `display_name` in the copy + button label (neutral fallback until/if it resolves).
- `apps/web/app/auth/callback/page.tsx` (modified) — B3: reads `opaque_state_id` from `sessionStorage`, includes it in the `/v1/auth/oidc/callback` POST body, clears the key after read (single-use), and shows an error + redirects to `/login` when the key is missing instead of POSTing `undefined`.
- `apps/web/src/lib/oidc.ts` (new) — shared `OIDC_OPAQUE_STATE_KEY` constant imported by both pages via the `@/` alias (the `@/*` alias maps to `src/*`, so it cannot live in a route `page.tsx`).
- `apps/web/src/lib/idp-info.ts` (new) — `IdpInfo` type, `IDP_FALLBACK_NAME`, and pure copy helpers (`resolveIdpName`, `idpCardCopy`, `idpButtonLabel`) so the copy-derivation is testable in the node-env vitest setup without a React renderer.
- `apps/web/src/lib/idp-info.test.ts` (new) — 5 hermetic tests: neutral fallback, trimmed `display_name`, copy/label rendering, fallback contains no "Microsoft", and Entra-in-prod label reflection.
- `tests/e2e/specs/auth.spec.ts` (modified) — button matchers switched to `/continue with .+/i` (+ a negative `/continue with microsoft/i` count-0 assertion); inline `/oidc/login` mock now returns `opaque_state_id`; the two deep-link `/auth/callback` tests now seed `sessionStorage` via `addInitScript` and one asserts the callback POST body carries `opaque_state_id`; stale "Continue with Microsoft" comments updated.
- `tests/e2e/fixtures/mock-api.ts` (modified) — added a public `GET /v1/auth/idp-info` handler (`{ display_name, issuer }`); `/v1/auth/oidc/login` now returns `201 { authorization_url, opaque_state_id }` (dropped the dead `authorize_url`/`state` fields).
- `tests/e2e/fixtures/auth.ts` (modified) — live-mode sign-in click matcher switched to `/continue with .+/i`; doc comments de-Microsoft'd and the callback path corrected to `/auth/callback`.
- `tests/e2e/specs/oidc-flow.spec.ts` (modified) — doc-comment matcher/path updated (IdP-agnostic button, `/auth/callback`).
- `tests/e2e/README.md` (modified) — live-stack flow description de-Microsoft'd, callback path corrected, IdP-agnostic label behaviour documented.

# Contract confirmation (canonical block — frontend side)
- `GET /v1/auth/idp-info` — CONSUMED. Login page fetches it via `apiFetch<IdpInfo>('/v1/auth/idp-info', { token: null })` and renders `display_name`. Matches backend's `{ display_name, issuer }`.
- `POST /v1/auth/oidc/login` — SENT `{ client_kind: 'web' }` (no `redirect_uri`). CONSUMES `resp.opaque_state_id` (uuid) and `resp.authorization_url`. Matches backend `LoginInitSchema` + `201` response.
- `POST /v1/auth/oidc/callback` — SENT `{ code, state, opaque_state_id }`. Matches backend `OidcCallbackSchema` (all three required). `opaque_state_id` is the value persisted from the `/oidc/login` response, round-tripped via `sessionStorage`.
- Browser lands on `/auth/callback` (Option B-web) — the page at `apps/web/app/auth/callback/page.tsx` already serves this route; backend points `OIDC_REDIRECT_URI_WEB` there. CONFIRMED end-to-end with the backend HANDOFF.

# How the copy degrades when idp-info is unavailable
- The button + copy initialise to the neutral fallback **"Continue with your identity provider"** / "Authentication is handled by your identity provider; …". The sign-in button is fully functional on first paint and **never blocks on the idp-info fetch**.
- The fetch runs in a `useEffect`; on success it swaps in `display_name` (e.g. "Continue with Keycloak"). On failure (network error, non-2xx, abort) the `catch` is a no-op — the neutral copy stays and sign-in still works. There is no error toast for idp-info; it is presentation-only.
- A blank/whitespace `display_name` from the endpoint also falls back to the neutral label (`resolveIdpName` trims + guards).
- Hardcoded "Microsoft Entra ID" / "Continue with Microsoft" strings are fully removed from the page (ADR-0001).

# What downstream agents need to know
- DECISION: introduced two small `apps/web/src/lib` modules (`oidc.ts` for the shared sessionStorage key, `idp-info.ts` for the pure copy helpers + type) rather than inlining. Reason: the `@/*` tsconfig alias maps only to `src/*`, so a constant shared between two route `page.tsx` files needs a `src/lib` home; and the node-env vitest setup (no jsdom/@testing-library installed) can only unit-test pure functions, so the copy logic was extracted to be testable without adding test deps.
- DECISION: button label is "Continue with {display_name}" (not a flat "Sign in") — keeps continuity with the prior UX while being provider-neutral. The dev value from the backend is `OIDC_DISPLAY_NAME=Keycloak`, so the live button reads "Continue with Keycloak".
- No new runtime dependencies added. No design-token or CSS-paradigm changes. The INC-001 CSP-nonce middleware is untouched (still 25.2 kB in the build).
- The hermetic mock-api's idp-info `display_name` is "Keycloak (dev)" (a fixture string); the real value is whatever the backend's `OIDC_DISPLAY_NAME` resolves to. E2e button matchers use `/continue with .+/i` so they are agnostic to the exact name.
- REMINDER (carried from backend HANDOFF, affects verify/live e2e): the running stack needs `docker compose down && docker compose up -d --build` so Keycloak re-imports the realm (new `/auth/callback` allowlist) AND the web bundle re-bakes `NEXT_PUBLIC_WEB_BASE_URL`. Until then the live round-trip still fails at Keycloak with `Invalid redirect_uri`. This is infra/devops, not a frontend code issue.

# Open questions / unknowns
- None blocking. Live (E2E_LIVE=1) Playwright was NOT run from this lane — it requires the rebuilt+re-imported stack (see reminder above) plus installed browsers, which is the verify step's job. Hermetic correctness was validated via vitest + the production build; the e2e spec edits were typecheck-validated.

# Verification evidence
- `pnpm --filter @harvoost/web test` → **12 passed (12)** — 5 new `idp-info` + 7 existing `middleware` (INC-001 regression). No failures.
- `pnpm --filter @harvoost/web typecheck` (`tsc --noEmit`) → **EXIT 0** (clean).
- `pnpm --filter @harvoost/web build` (Next 14 production build) → **EXIT 0**; `/login` (3.71 kB) and `/auth/callback` (3.16 kB) compile; middleware intact (25.2 kB).
- e2e package `tsc --noEmit` → my edited files (`auth.spec.ts`, `mock-api.ts`, `fixtures/auth.ts`, `oidc-flow.spec.ts`) produce **0 errors**. (Pre-existing, unrelated `findLast`/lib-target errors remain only in `specs/chatbot.spec.ts`, which I did not touch.)
- Full unit/integration baseline (re-run): api **227** + web **12** + db **21** + shared **91** + jobs **40** = **391 passed**, plus the **1 known pre-existing** failure `@harvoost/shared > RbacScopeService > throws RbacError on empty requesterId` (accepted baseline, in `packages/shared`, outside this change set). No regressions from the frontend lane.
- Live e2e (`E2E_LIVE=1`) → **NOT run** from this lane (needs the rebuilt/re-imported stack + browsers per the reminder above). Hermetic specs were edited but not executed here (Playwright run is the verify step's responsibility); their TypeScript compiles clean.

---

# Addendum (2026-05-23) — Avatar missing-name crash hardening

## The bug
After a successful Keycloak login the `/timesheets` shell crashed into the React error boundary with `Cannot read properties of undefined (reading 'trim')`. Root cause: `GET /v1/auth/me` returned no `display_name`, so `AppShell.tsx:169` passed `undefined` into `<Avatar name={...} />`, and `Avatar.tsx`'s `initialsOf(name)` called `name.trim()` unguarded → crash. The `backend-dev` lane is concurrently making `display_name` a guaranteed non-empty string on `/v1/auth/me`; this addendum is the FRONTEND defense-in-depth so a missing name can NEVER crash the shell, plus the consumer type.

## Files changed
- `packages/ui/src/components/Avatar.tsx` (modified) — made null/undefined/empty-safe:
  - `AvatarProps.name` is now `string | undefined | null` (was required `string`).
  - `initialsOf` is now exported and accepts `string | null | undefined`; it coalesces to `''`, trims, and returns `'?'` for any empty/whitespace input instead of throwing. Also guards the two-word path so an all-whitespace-split can never produce an empty string.
  - `aria-label` degrades: when `name` is missing/blank the label is `'User'` (never an empty `aria-label`), otherwise it is the provided name.
  - The component now renders without throwing for ANY input.
- `apps/web/src/lib/auth.ts` (modified) — the `/v1/auth/me` consumer type. `CurrentUser.display_name` was already typed `string`; added an INC-002 comment documenting that the backend guarantees it non-empty. (No type widening needed — it is already a non-`undefined` `string` at the type level.)
- `apps/web/src/components/AppShell.tsx` (modified) — light-touch runtime fallback: computes `const displayName = user.display_name?.trim() ? user.display_name : user.email;` and uses it for both `<Avatar name={displayName} />` and the visible name line. Belt-and-braces only; the type guarantee is unchanged.
- `apps/web/__tests__/avatar.test.ts` (new) — 9 hermetic tests (vitest, node env, `react-dom/server` `renderToStaticMarkup` + `React.createElement`, no new deps): `initialsOf` returns `'?'` for `undefined`/`null`/`''`/whitespace; derives initials for real names; `Avatar` renders without throwing for each of `undefined`/`null`/`''`/whitespace/real name (the path that previously crashed); fallback `aria-label="User"` + `?` glyph when name is missing; real name → `AL` initials + `aria-label="Ada Lovelace"`.
- `apps/web/vitest.config.ts` (modified, test-only) — added `esbuild: { jsx: 'automatic' }` so component `.tsx` modules imported by tests compile with the automatic JSX runtime (the `@harvoost/ui` barrel evaluates `Toast.tsx` etc. which use JSX without a classic `React` import). Test-config only; no app/runtime behaviour change.

## How Avatar now degrades
- `name` `undefined` / `null` / `''` / all-whitespace → initials render `'?'`, `aria-label` is `'User'`. No throw.
- Single token (e.g. `"Ada"`) → first letter, uppercased (`"A"`).
- Multiple tokens → first + last initial, uppercased (`"Ada Lovelace"` → `"AL"`), whitespace-collapsed.
- `aria-label` is always non-empty (the name when present, else `'User'`), so screen readers never announce an empty image label.
- AppShell additionally falls back to `user.email` if `display_name` is ever blank at runtime, so the visible identity line and the avatar can't render blank.

## Consumer type change
- `CurrentUser` (the typed shape of `GET /v1/auth/me`, in `apps/web/src/lib/auth.ts`) already declared `display_name: string`. It is NOT `undefined` at the type level. Added a documenting comment tying it to the backend's INC-002 guarantee. The crash was a runtime contract gap (backend omitting the field), now defended in the component and consumer.

## Constraints honoured
- Touched only `apps/web/` and `packages/ui/`. Did not touch `apps/api/`, `infra/`, `.env`, `docker/`, `.github/`.
- Did not alter the real-Entra-in-prod path or unrelated UI. No new runtime dependencies. No design-token / CSS-paradigm changes.

## Verification evidence (addendum)
- `pnpm --filter @harvoost/web test` → **21 passed (21)** = 5 idp-info + 7 middleware + **9 new avatar**. No failures.
- `pnpm --filter @harvoost/ui typecheck` (`tsc --noEmit`) → **EXIT 0** (clean).
- `pnpm --filter @harvoost/web exec tsc --noEmit` → **EXIT 0** (clean).
- `pnpm test` (full monorepo) → only failure is the **known pre-existing** `@harvoost/shared > RbacScopeService > throws RbacError on empty requesterId` (accepted baseline, outside this change set). Web suite now contributes 21 (was 12: +9), so the new unit baseline is **400 passed** + the 1 known shared failure. No new regressions.
- Lint (`eslint`) is environment-broken repo-wide (ESLint v9 expects `eslint.config.js`, repo has none) — pre-existing, not part of the green baseline and unrelated to this change.
