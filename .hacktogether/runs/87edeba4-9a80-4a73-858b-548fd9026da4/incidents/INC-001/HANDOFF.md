---
phase: incident
agent: debugger
started: 2026-05-23T08:09Z
finished: 2026-05-23T08:25Z
status: complete
---

# Summary
Reproduced INC-001 against `main@dd02c85` on the running docker compose stack, isolated the root cause to a misconfigured `Content-Security-Policy` in `apps/web/next.config.mjs`: the `script-src 'self' 'wasm-unsafe-eval'` directive lacks `'unsafe-inline'` and lacks a per-request nonce, so the browser refuses to execute the inline `<script>` tags Next.js 14 emits to stream the RSC flight payload into `self.__next_f`. Without that payload `ClientPageRoot` never hydrates and the SSR'd LoadingSpinner is the only thing that paints. Eliminated four of the reporter's five suspected causes (1, 2, 3, 5) with positive disconfirming evidence and verified that cause #4 — `NEXT_PUBLIC_API_BASE_URL` build-time baking — is a latent footgun but not the active bug (the source-default `http://localhost:3001` happens to equal the actual API URL). Root cause and hotfix plan documented; no code changes made.

# Files touched
- `.hacktogether/runs/87edeba4-9a80-4a73-858b-548fd9026da4/incidents/INC-001/ROOT_CAUSE.md` (modified)
- `.hacktogether/runs/87edeba4-9a80-4a73-858b-548fd9026da4/incidents/INC-001/HOTFIX_PLAN.md` (modified)
- `.hacktogether/runs/87edeba4-9a80-4a73-858b-548fd9026da4/incidents/INC-001/REPRO_LOG.md` (modified)
- `.hacktogether/runs/87edeba4-9a80-4a73-858b-548fd9026da4/incidents/INC-001/HANDOFF.md` (new)

# What downstream agents need to know
- **The actual root cause is CSP-related, not auth/cookie/CORS/env-related** — the reporter's #1, #2, #3, #5 are all wrong and #4 is latent-not-active. Don't waste implementer cycles chasing the original suspect list.
- **Minimum-viable fix**: add `'unsafe-inline'` to `script-src` in `apps/web/next.config.mjs:31`. Single line, ~5 LOC change including a comment explaining the trade-off. Recommend `frontend-dev`.
- **Principled fix** (recommend deferring to v0.2.0): implement a per-request nonce in `apps/web/middleware.ts` and propagate via `headers().get('x-nonce')`. Riskier as a same-day hotfix because it interacts with the home page's `x-nextjs-cache: HIT` static-render path.
- **Two latent bugs found in the same hour, both worth tracking but neither blocks the hotfix**:
  1. `docker/Dockerfile.web` does not pass `NEXT_PUBLIC_API_BASE_URL` as a build arg, so the docker-compose `environment:` value is silently ignored at build time. Next.js bakes `NEXT_PUBLIC_*` at BUILD, not RUN — only the source default in `apps/web/src/lib/env.ts` is used. The hang isn't caused by this only because the default matches; changing the API URL anywhere would resurface as a real bug.
  2. `docker-compose.yml`'s `web` service inherits `HOSTNAME=<container-id>` from Docker, so Next.js binds only to the bridge IP `172.26.0.7:3000`. The container healthcheck (which fetches `http://localhost:3000/` via 127.0.0.1) gets `ECONNREFUSED` and the container is permanently `unhealthy`. The browser is unaffected because Docker port-forwarding targets eth0. Recommend setting `HOSTNAME=0.0.0.0` in the `web` service env block. Until fixed, `harvoost-web`'s `unhealthy` status is meaningless and will mask any genuine web-server failures.
- **The compiled web bundle is otherwise correct** — `useCurrentUser`, `apiFetch`, the QueryClient retry policy, the `useEffect`-based redirect-to-/login are all properly handled in the chunks. Once CSP is unblocked, the page will hydrate and redirect.
- **Estimated fix LOC**: 1 line (minimum-viable). Test addition: ~10-20 LOC for the assertion test described in HOTFIX_PLAN.md.

# Open questions / unknowns
- Did the reporter (or anyone) verify the spinner hang in an actual browser, or only via the curl-returning-200 observation? If a real browser was used, the console would have shown CSP violation messages — those messages would have made this incident close in 5 minutes instead of 1 hour. Worth asking the reporter to attach the next browser console screenshot to bug reports.
- For the hotfix: minimum-viable (`'unsafe-inline'`) versus principled (nonce). Both are documented in HOTFIX_PLAN.md; the orchestrator / project owner should pick. My recommendation is minimum-viable for v0.1.0 and a v0.2.0 follow-up issue for the nonce strategy.

# Verification evidence
- `curl -sI http://localhost:3000/ | grep Content-Security-Policy` → `script-src 'self' 'wasm-unsafe-eval'` (the smoking gun — no `'unsafe-inline'`, no nonce).
- `curl -s http://localhost:3000/ | grep -oE '<script>[^<]{0,80}' | wc -l` → `5` inline `<script>` tags present in the served HTML.
- `curl -s http://localhost:3000/ | grep -ocE 'nonce='` → `0` (no nonces).
- `curl -v -H "Origin: http://localhost:3000" -H "X-Requested-With: XMLHttpRequest" http://localhost:3001/v1/auth/me` → `401` with `Access-Control-Allow-Origin: http://localhost:3000` (confirms the API + CORS path works — refutes causes #1, #2, #3).
- `docker exec harvoost-web sh -c "grep -l 'NEXT_PUBLIC_API_BASE_URL' /app/apps/web/.next/static/chunks/*.js"` plus reading module 2688 and 9492 → API URL falls back to `'http://localhost:3001'` via the process-shim path, equals actual API URL → refutes that #4 is the active cause.
- `docker exec harvoost-web sh -c "cat /proc/net/tcp"` → server bound to `172.26.0.7:3000` only, not `127.0.0.1:3000` → explains the unhealthy state (separate latent bug).
- Read of compiled `app/page-85143e592d27611d.js` modules 8848 and 3456 → client code correctly catches 401/403 and redirects via `router.replace('/login')`. The redirect never fires because hydration never starts.
