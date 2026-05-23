# INC-001 — Root cause

## Final root cause (one sentence)

The web app's `Content-Security-Policy` header set in `apps/web/next.config.mjs` declares `script-src 'self' 'wasm-unsafe-eval'` with **no** `'unsafe-inline'` and **no** nonce, which causes the browser to block every inline `<script>` Next.js emits to push the RSC flight payload into `self.__next_f`; without that payload the `ClientPageRoot` never hydrates, so the static `LoadingSpinner` SSR'd by `app/page.tsx` is the only thing that ever paints.

## Hypothesis history

1. **H1: `NEXT_PUBLIC_API_BASE_URL` baked at build time was wrong / missing (reporter's #4)** — Tested by `docker exec harvoost-web sh -c "grep -l 'NEXT_PUBLIC_API_BASE_URL' /app/apps/web/.next/static/chunks/*.js"` and reading the surrounding code. The bundle does NOT inline a literal URL — it goes through the webpack `process` polyfill (module `9492` → `4328`) — so in the browser `process.env.NEXT_PUBLIC_API_BASE_URL` is `undefined` and the fallback `'http://localhost:3001'` from `src/lib/env.ts` is used. That fallback equals the actual runtime API URL, so the URL resolves correctly. Result: **refuted** as the cause of the hang (though there is a separate latent issue — see "Prevention").

2. **H2: `/v1/auth/me` returns 401 and TanStack Query stays `pending` (reporter's #1)** — Tested by reading the compiled chunk `app/page-85143e592d27611d.js`. The compiled `useCurrentUser` catches `ApiError` with `status === 401 || 403` and returns `null`, transitioning the query to `success` with `data = null`. The `useEffect` in `HomePage` then calls `router.replace('/login')`. The api returns 401 in ~5ms (curl-confirmed). Result: **refuted**.

3. **H3: CSRF middleware blocks the cookie roundtrip (reporter's #2)** — Tested with `curl -v -H "Origin: http://localhost:3000" -H "X-Requested-With: XMLHttpRequest" http://localhost:3001/v1/auth/me` → 401 with the proper `OIDC_FAILURE` envelope, `Access-Control-Allow-Origin: http://localhost:3000`, `Access-Control-Allow-Credentials: true`. The web bundle does send `X-Requested-With: XMLHttpRequest` (verified in compiled `apiFetch`). Result: **refuted**.

4. **H4: CORS preflight failure** — Tested with `curl -v -X OPTIONS -H "Origin: http://localhost:3000" -H "Access-Control-Request-Method: GET" -H "Access-Control-Request-Headers: x-requested-with" http://localhost:3001/v1/auth/me` → 204 with all the right `Access-Control-*` headers. Result: **refuted**.

5. **H5: web container `HOSTNAME` causes Next.js to bind to the bridge IP only, breaking healthcheck** — `docker exec harvoost-web sh -c "cat /proc/net/tcp"` shows Next.js listening on `172.26.0.7:3000` (the bridge IP) only, not `0.0.0.0` or `127.0.0.1`. The healthcheck (`fetch('http://localhost:3000/')` from inside the container → `127.0.0.1:3000`) gets `ECONNREFUSED`. **This explains why the container is `unhealthy` but does NOT explain the browser spinner** — port-forwarding from the host's `127.0.0.1:3000` reaches the container's eth0 fine, which is why `curl http://localhost:3000/` from the host returns HTTP 200. Result: **inconclusive for the spinner — a real separate bug but not THE bug.** Worth fixing separately (see Prevention).

6. **H6: CSP blocks Next.js's inline RSC payload scripts** — Tested by:
   a. `curl -sI http://localhost:3000/` → CSP header is `script-src 'self' 'wasm-unsafe-eval'` (no `'unsafe-inline'`, no `'nonce-...'`).
   b. `curl -s http://localhost:3000/ | grep -oE '<script>[^<]{0,80}'` → at least 5 inline `<script>` tags pushing to `self.__next_f`, none of which carry a `nonce` attribute (verified `grep -c 'nonce='` → `0`).
   c. Cross-referenced `apps/web/next.config.mjs:25-45` — the CSP is a hand-written string that includes `'unsafe-inline'` for `style-src` but NOT for `script-src`, and the headers function does not generate a per-request nonce or attach it to Next.js's `next/script` infrastructure.
   d. The rendered HTML shows the `LoadingSpinner` directly in the body (it's the prerendered server output of `HomePage`). Any subsequent hydration depends on Next 14's RSC flight protocol, which uses these inline scripts to populate `self.__next_f`. Without them, `ClientPageRoot` never receives its serialized tree, `useCurrentUser` never runs, and the spinner is the terminal state.
   Result: **confirmed**.

## Evidence supporting the final cause

- `apps/web/next.config.mjs:25-45` — CSP string:
  ```
  "script-src 'self' 'wasm-unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  ```
  Note the asymmetry: `'unsafe-inline'` for styles but not scripts, and no `'nonce-...'` token in either.

- Response header from `curl -sI http://localhost:3000/`:
  ```
  Content-Security-Policy: default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self' http://localhost:3001; frame-ancestors 'none'; base-uri 'self'; form-action 'self'
  ```

- Response body fragments (from `curl -s http://localhost:3000/ | grep -oE '<script>[^<]{0,80}'`):
  ```
  <script>(self.__next_f=self.__next_f||[]).push([0]);self.__next_f.push([2,null])
  <script>self.__next_f.push([1,"1:HL[\"/_next/static/css/4d731e2058687652.css\",\"style\"
  <script>self.__next_f.push([1,"2:I[3018,[],\"\"]\n4:I[8702,[],\"ClientPageRoot\"]\n5:I[8
  <script>self.__next_f.push([1,"0:[\"$\",\"$L2\",null,{\"buildId\":\"Mq2Aj2-4lKrehSIAwDUR
  <script>self.__next_f.push([1,"b:[[\"$\",\"meta\",\"0\",{\"name\":\"viewport\",\"content
  ```
  These are inline scripts with **no** `nonce` attribute. CSP `script-src 'self' 'wasm-unsafe-eval'` blocks them.

- `grep -c 'nonce=' <html>` → `0` (no nonces emitted).

- The compiled `HomePage` in `app/page-85143e592d27611d.js` is correct — `useCurrentUser` properly catches 401/403 and returns null, then `useEffect` calls `router.replace('/login')`. So once hydration happens, the page WOULD redirect. The spinner is solely a consequence of hydration never starting because the RSC payload is blocked.

- All non-CSP fallbacks check out: api returns 401 quickly with CORS allowed, the bundled URL is correct, the static HTML is served fine, the QueryClient is configured sanely.

## Why the prior 5-suspect-list ranking was right/wrong

- **#1 (`/v1/auth/me` 401 keeps query pending)** — wrong. The query function handles 401 explicitly and returns null. `isLoading` would correctly transition to false IF the client ever ran.
- **#2 (CSRF middleware blocks cookie roundtrip)** — wrong. The web client already sends `X-Requested-With: XMLHttpRequest` and the request returns a clean 401 from `OidcGuard`/`AuthController.me`, not from CSRF middleware.
- **#3 (OIDC redirect host mismatch)** — N/A. The OIDC redirect chain isn't reached because the user is never given the chance to click "Sign in" — the `/login` page is never rendered.
- **#4 (`NEXT_PUBLIC_API_BASE_URL` baked vs runtime)** — wrong about being the cause, but a latent footgun: the Dockerfile.web does NOT pass `NEXT_PUBLIC_API_BASE_URL` as a build arg, AND `src/lib/env.ts`'s runtime fallback is `http://localhost:3001`. The runtime env override in docker-compose.yml is effectively ignored. It only "works" because the default matches the actual API URL. If someone changes the api port without updating the source default, this becomes a real bug. Worth fixing alongside the CSP fix.
- **#5 (Suspense boundary waiting on failing /me)** — wrong. `useCurrentUser` doesn't use Suspense (`useQuery`, not `useSuspenseQuery`), and there's no `<Suspense>` boundary in the root tree.

**The actual cause was not on the suspect list.** It is a **Content-Security-Policy misconfiguration in `apps/web/next.config.mjs`** — the security-conscious "no `'unsafe-inline'`" choice silently breaks Next.js 14's RSC hydration protocol because that protocol requires either a per-request CSP nonce mechanism (which Next.js supports via middleware) or `'unsafe-inline'` for `script-src`.

