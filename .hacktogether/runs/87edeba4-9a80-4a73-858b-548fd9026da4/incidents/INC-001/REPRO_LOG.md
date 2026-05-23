# INC-001 — Reproduction log

Raw evidence captured 2026-05-23 against commit `dd02c85` on `main`, stack already running from prior `docker compose up -d --build`.

## 1. Container state

```
$ docker ps --format "table {{.Names}}\t{{.Status}}"
NAMES               STATUS
harvoost-keycloak   Up 24 minutes (healthy)
harvoost-web        Up 24 minutes (unhealthy)        <-- web is unhealthy
harvoost-api        Up 24 minutes (healthy)
harvoost-postgres   Up 25 minutes (healthy)
harvoost-azurite    Up 25 minutes (unhealthy)        <-- known-broken azurite healthcheck
harvoost-maildev    Up 25 minutes (healthy)
```

## 2. HTTP probe: web root returns 200 with a static spinner shell

```
$ curl -sI http://localhost:3000/
HTTP/1.1 200 OK
X-Frame-Options: DENY
Referrer-Policy: strict-origin-when-cross-origin
X-Content-Type-Options: nosniff
Content-Security-Policy: default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self' http://localhost:3001; frame-ancestors 'none'; base-uri 'self'; form-action 'self'
Vary: RSC, Next-Router-State-Tree, Next-Router-Prefetch, Accept-Encoding
x-nextjs-cache: HIT
Cache-Control: s-maxage=31536000, stale-while-revalidate
ETag: "sgqq9ppelg5og"
Content-Type: text/html; charset=utf-8
Content-Length: 7367
```

Body contains the SSR'd loading spinner literally:
```
<div class="flex min-h-screen items-center justify-center">
  <span role="status" aria-live="polite" class="inline-flex items-center gap-2 text-neutral-500">
    <span aria-hidden="true" class="inline-block animate-spin rounded-full border-neutral-300 border-t-brand-600 h-8 w-8 border-[3px]"></span>
    <span class="sr-only">Loading Harvoost</span>
  </span>
</div>
```

Body also contains five inline `<script>` tags pushing the RSC flight payload:
```
$ curl -s http://localhost:3000/ | grep -oE '<script>[^<]{0,80}'
<script>(self.__next_f=self.__next_f||[]).push([0]);self.__next_f.push([2,null])
<script>self.__next_f.push([1,"1:HL[\"/_next/static/css/4d731e2058687652.css\",\"style\"
<script>self.__next_f.push([1,"2:I[3018,[],\"\"]\n4:I[8702,[],\"ClientPageRoot\"]\n5:I[8
<script>self.__next_f.push([1,"0:[\"$\",\"$L2\",null,{\"buildId\":\"Mq2Aj2-4lKrehSIAwDUR
<script>self.__next_f.push([1,"b:[[\"$\",\"meta\",\"0\",{\"name\":\"viewport\",\"content
```

None of these inline tags carry a nonce:
```
$ curl -s http://localhost:3000/ | grep -ocE 'nonce='
0
```

→ Combined with the `script-src 'self' 'wasm-unsafe-eval'` directive (no `'unsafe-inline'`, no `'nonce-...'`), every modern browser will refuse to execute these inline scripts. Without them, `self.__next_f` never receives the RSC flight payload, `ClientPageRoot` never hydrates, and the spinner stays forever.

## 3. API probe: /v1/auth/me responds correctly to unauthenticated calls

```
$ curl -v http://localhost:3001/v1/auth/me 2>&1 | grep -E 'HTTP|Allow|Credentials|^{'
< HTTP/1.1 401 Unauthorized
< Access-Control-Allow-Credentials: true
{"code":"OIDC_FAILURE","message":"Missing session credential (Bearer header or session cookie)."}
```

With browser-equivalent headers:
```
$ curl -v -H "Origin: http://localhost:3000" -H "X-Requested-With: XMLHttpRequest" http://localhost:3001/v1/auth/me 2>&1 | grep -E 'HTTP|Access-Control|^{'
< HTTP/1.1 401 Unauthorized
< Access-Control-Allow-Origin: http://localhost:3000
< Access-Control-Allow-Credentials: true
{"code":"OIDC_FAILURE","message":"Missing session credential (Bearer header or session cookie)."}
```

CORS preflight:
```
$ curl -v -X OPTIONS -H "Origin: http://localhost:3000" -H "Access-Control-Request-Method: GET" -H "Access-Control-Request-Headers: x-requested-with" http://localhost:3001/v1/auth/me 2>&1 | grep -E 'HTTP|Access-Control'
< HTTP/1.1 204 No Content
< Access-Control-Allow-Origin: http://localhost:3000
< Access-Control-Allow-Credentials: true
< Access-Control-Allow-Methods: GET,HEAD,PUT,PATCH,POST,DELETE
< Access-Control-Allow-Headers: x-requested-with
```

→ API + CORS work. The hang is NOT here.

## 4. Web healthcheck failure (separate bug, masks future regressions)

```
$ docker inspect harvoost-web --format '{{json .Config.Healthcheck}}'
{"Test":["CMD","node","-e","fetch('http://localhost:3000/').then(r=>{process.exit(r.ok?0:1)}).catch(()=>process.exit(1))"],"Interval":10000000000,"Timeout":5000000000,"StartPeriod":30000000000,"Retries":10}

$ docker exec harvoost-web sh -c "node -e \"fetch('http://127.0.0.1:3000/').then(r=>console.log('status:', r.status)).catch(e=>{console.error(e.message); console.error(JSON.stringify(e.cause))})\""
fetch failed
{"errno":-111,"code":"ECONNREFUSED","syscall":"connect","address":"127.0.0.1","port":3000}

$ docker exec harvoost-web sh -c "netstat -tlnp"
Active Internet connections (only servers)
Proto Recv-Q Send-Q Local Address           Foreign Address         State       PID/Program name
tcp        0      0 172.26.0.7:3000         0.0.0.0:*               LISTEN      7/next-server (v14.

$ docker exec harvoost-web sh -c "cat /proc/7/environ | tr '\\0' '\\n' | grep HOSTNAME"
HOSTNAME=63bd0475539d
```

→ Next.js sees `HOSTNAME=63bd0475539d` (the container ID, set by docker), resolves it to the bridge IP `172.26.0.7`, and binds to that single IP. `127.0.0.1:3000` inside the container is dead. The host's `127.0.0.1:3000` works because Docker port-forwarding targets the eth0 IP, not `localhost`. **This is a real bug but is NOT the cause of the spinner — the browser request from the host reaches the server fine.**

## 5. Web bundle inspection — proves the home page client code is correct

```
$ docker exec harvoost-web sh -c "grep -l '/v1/auth/me' /app/apps/web/.next/static/chunks/*.js /app/apps/web/.next/static/chunks/app/*.js"
/app/apps/web/.next/static/chunks/7898-0fc34e2b73b6e6e9.js
/app/apps/web/.next/static/chunks/8414-adb8e03c99ef4309.js
/app/apps/web/.next/static/chunks/app/page-85143e592d27611d.js
```

Compiled `useCurrentUser` (module 3456 in `page-85143e592d27611d.js`):
```js
3456:function(t,e,n){
  n.d(e,{xJ:function(){return a}});
  var r=n(3055), o=n(7314);
  function a(){
    return (0,r.a)({
      queryKey:["auth","me"],
      queryFn:async()=>{
        try{return await (0,o.SC)("/v1/auth/me")}
        catch(t){
          if(t instanceof o.MS && (401===t.status || 403===t.status)) return null;
          throw t
        }
      },
      staleTime:6e4, retry:!1
    })
  }
}
```

Compiled `HomePage` (module 8848 in `page-85143e592d27611d.js`):
```js
8848:function(t,e,n){
  n.r(e); n.d(e,{default:function(){return u}});
  var r=n(1626), o=n(4987), a=n(2172), s=n(3007), i=n(3456);
  function u(){
    let t=(0,a.useRouter)(),
        {data:e,isLoading:n}=(0,i.xJ)();
    return (0,o.useEffect)(()=>{
      n || (e ? t.replace("/timesheets") : t.replace("/login"))
    },[e,n,t]),
    (0,r.jsx)("div",{className:"flex min-h-screen items-center justify-center",
      children:(0,r.jsx)(s.TK,{size:"lg",label:"Loading Harvoost"})})
  }
}
```

→ The client code is correct. 401 is handled, null is returned, useEffect redirects to /login. The reason this code never runs is that the hydration entry point (`self.__next_f` flight payload) is blocked by CSP before this module is reached.

## 6. Env / build args — refutes cause #4

```
$ docker exec harvoost-web env | grep -i 'NEXT\|API\|KEYCLOAK\|OIDC\|WEB' | sort
NEXT_PUBLIC_API_BASE_URL=http://localhost:3001
NEXT_TELEMETRY_DISABLED=1
OIDC_CLIENT_ID=harvoost-web
OIDC_CLIENT_SECRET=dev-keycloak-client-secret-not-for-prod
OIDC_ISSUER_URL=http://localhost:8080/realms/harvoost
OIDC_REDIRECT_URI_TRAY=harvoost://auth/callback
OIDC_REDIRECT_URI_WEB=http://localhost:3000/v1/auth/callback
OPENAI_API_KEY=__REPLACE_ME__
WEB_ORIGIN=http://localhost:3000
```

Compiled `env.ts` (module 2688):
```js
2688:function(e,t,n){
  n.d(t,{O:function(){return s}});
  var r, o, a = n(9492);  // module 9492 is the webpack process polyfill
  let s = {
    API_BASE_URL: null !== (r = a.env.NEXT_PUBLIC_API_BASE_URL) && void 0 !== r ? r : "http://localhost:3001",
    WEB_BASE_URL: null !== (o = a.env.NEXT_PUBLIC_WEB_BASE_URL) && void 0 !== o ? o : "http://localhost:3000"
  }
}

9492:function(t,e,n){
  "use strict";
  var r, i;
  t.exports = (null==(r=n.g.process) ? void 0 : r.env) && "object" == typeof (null==(i=n.g.process) ? void 0 : i.env)
    ? n.g.process
    : n(4328);  // n(4328) is the browser process shim with env={}
}
```

→ In the browser, `n.g.process` is undefined, so `a` falls back to the process-shim with empty `env`. `a.env.NEXT_PUBLIC_API_BASE_URL` is `undefined`, so the default `"http://localhost:3001"` is used. This *happens* to equal the actual API URL, so cause #4 is not active right now. But the `NEXT_PUBLIC_*` env var is NOT actually being baked into the bundle by Next.js at build time — `docker/Dockerfile.web` does not pass it as a build arg, and Next.js's webpack DefinePlugin doesn't fire for variables that aren't present at build. This is a latent footgun, not the spinner cause.

## 7. CSP source

```
$ cat apps/web/next.config.mjs
...
  async headers() {
    const apiOrigin = process.env.NEXT_PUBLIC_API_BASE_URL ?? 'http://localhost:3001';
    return [
      {
        source: '/(.*)',
        headers: [
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          {
            key: 'Content-Security-Policy',
            value: [
              "default-src 'self'",
              "script-src 'self' 'wasm-unsafe-eval'",          // <-- BUG: no 'unsafe-inline', no nonce
              "style-src 'self' 'unsafe-inline'",
              "img-src 'self' data: blob:",
              `connect-src 'self' ${apiOrigin}`,
              "frame-ancestors 'none'",
              "base-uri 'self'",
              "form-action 'self'",
            ].join('; '),
          },
        ],
      },
    ];
  },
...
```

→ This is the source of the bug. Next.js 14's `app/` router uses inline `<script>` tags to stream the RSC flight payload. Without `'unsafe-inline'` or a per-request nonce on `script-src`, every browser blocks these scripts and hydration never starts.

