# INC-001 — Hotfix plan

## Suggested implementer(s)

- `frontend-dev` — primary owner of `apps/web/next.config.mjs`.
- `devops` (optional, only if H5 follow-up is in scope) — to also set `HOSTNAME=0.0.0.0` for the `web` service in `docker-compose.yml` so the container healthcheck stops flapping.

## Files to change (with line ranges where known)

- `apps/web/next.config.mjs:25-45` — the CSP definition inside the `headers()` async function. The minimum-viable fix is to add `'unsafe-inline'` (and also `'unsafe-eval'` if any non-RSC dynamic script paths are exercised in production) to `script-src`. The principled fix is to switch to a **per-request nonce** strategy:
    - Add an `apps/web/middleware.ts` that generates a random nonce, sets it on `request.headers['x-nonce']`, and writes the CSP header with `'nonce-<nonce>'` in `script-src` (and removes the static CSP from `next.config.mjs`). Then in `app/layout.tsx`, read the nonce via `headers().get('x-nonce')` and pass it to any `next/script` tags. Next.js 14 will automatically propagate the nonce to its own inline RSC scripts when a CSP header with a nonce is observed.
    - References: <https://nextjs.org/docs/app/building-your-application/configuring/content-security-policy>.
    - For the v0.1.0 hotfix, the **minimum-viable change** is the simpler path — see "Risk of regression" for why nonces are recommended for v0.2.0+.

- (optional, latent footgun #4 follow-up) `docker/Dockerfile.web` build stage and `apps/web/src/lib/env.ts` — make the build-time bake explicit so a future API URL change doesn't silently fall back to `http://localhost:3001`. Add `ARG NEXT_PUBLIC_API_BASE_URL` + `ENV NEXT_PUBLIC_API_BASE_URL=$NEXT_PUBLIC_API_BASE_URL` in the build stage, and a docker-compose `build.args` entry. **Not required to close this incident** — only the CSP change is required.

- (optional, H5 follow-up) `docker-compose.yml` `web` service — add `environment: HOSTNAME=0.0.0.0`, so the container healthcheck stops flapping. **Not required to close this incident** — but worth fixing so future failures of the web container are detected, not masked.

## Tests to add or update

- New unit test (`apps/web/__tests__/csp.test.ts` or similar) that imports the `headers()` callback from `next.config.mjs`, executes it, and asserts that the `Content-Security-Policy` value for `/(.*)` includes either `'unsafe-inline'` in the `script-src` directive **or** a `'nonce-...'` token. This is a behaviour test, not an implementation test: whoever changes the CSP can pick either strategy as long as Next.js inline scripts will be permitted.
- (existing 375-test suite) — must continue to pass. No expected test churn.
- (optional, e2e) Add a Playwright spec under `tests/e2e/` that visits `http://localhost:3000/` against the dockerised stack and asserts the page navigates to `/login` (i.e. the URL changes off `/`) within 5 seconds. This is the closest possible regression test for "spinner stays forever."

## Migration concerns

None. Frontend-only HTTP-header config change. No DB migrations, no API contract changes, no token-format changes.

## Risk of regression

- **Minimum-viable fix (`'unsafe-inline'` for `script-src`)**: weakens the web app's CSP posture — a stored-XSS payload would no longer be mitigated by CSP. For a v0.1.0 stack with an internal authenticated user base and an existing input-sanitisation layer (`packages/shared` validators), this is acceptable risk to unblock the demo, but should be replaced with a nonce strategy before any external rollout.
- **Nonce fix**: more invasive (adds middleware, may interact with response caching — the home page is currently `x-nextjs-cache: HIT`-able static, and dynamic CSP nonces force per-request rendering). Worth doing in v0.2.0 but riskier as a same-day hotfix.
- **Tray app**: not affected — `apps/tray` is a separate Electron app and doesn't share `next.config.mjs`.
- **Admin pages, SSE timer sync, OIDC callback page**: all live under the same CSP and all currently broken in the same way. Fixing CSP fixes them all simultaneously.
- **CSS / images / API calls**: untouched by this fix — `style-src` already has `'unsafe-inline'`, `connect-src` already includes the api origin.

## Verification steps (for the verifier, after the fix)

1. `docker compose down && docker compose up -d --build`
2. `curl -sI http://localhost:3000/ | grep -i content-security-policy` → the `script-src` directive must include either `'unsafe-inline'` or a `'nonce-<base64>'` token.
3. `curl -s http://localhost:3000/ -L -o /tmp/home.html && grep -c '<script>' /tmp/home.html` → still > 0 (inline scripts are present, just now allowed by CSP).
4. Cross-check: open `http://localhost:3000/` in a real browser. The page should briefly show the spinner, then redirect to `/login` and render the Microsoft sign-in card. Verify the browser console contains **zero** `Refused to execute inline script because it violates the following Content Security Policy directive` messages.
5. `pnpm test` — 375 tests must still pass.
6. (if the optional H5 fix is also applied) `docker inspect harvoost-web --format '{{json .State.Health.Status}}'` → `"healthy"` within 60 seconds of `docker compose up`.

## Rollback

- `git revert <hotfix-commit>` reverts the CSP change atomically. The only side effect is the spinner-hang returns. No data state to roll back. No cache to purge (the static `/` response is HTML + serialised RSC and is naturally cache-busted on rebuild).

