# @harvoost/tray

Cross-platform Electron tray app for Harvoost. Clock in/out + mood capture, with
SSE sync back to the web app.

## Architecture

- **Main process** (`main/`) owns the bearer token (keychain via `keytar`), all HTTP
  traffic, the SSE sync stream, and the system-tray icon + popover window.
- **Renderer** (`renderer/`) is a small React app reused from `@harvoost/ui`. It NEVER
  makes HTTP calls directly — every API call goes through `window.harvoost.api.request`
  (exposed by the preload script). This is the CORS strategy decided in
  ARCHITECTURE.md § Electron CORS strategy r2.
- **Preload** (`preload/`) is the typed bridge.

## Dev

```sh
# In one terminal: start the API + web at http://localhost:3001 / :3000.
pnpm --filter @harvoost/web dev

# In another terminal: build the main process and start the renderer dev server.
pnpm --filter @harvoost/tray dev
```

Environment variables read by the tray (main process):

| Var | Default | Purpose |
|---|---|---|
| `HARVOOST_API_URL` | `http://localhost:3001` | Base URL for the Harvoost API. |
| `NODE_ENV` | `production` | Set to `development` to enable devtools + Vite dev server load. |

## Packaging (v1 — UNSIGNED)

```sh
pnpm --filter @harvoost/tray package
```

Outputs go to `apps/tray/out/`. Per architecture decision r2 the v1 build is
**unsigned**; SmartScreen (Windows) and Gatekeeper (macOS) will warn end users
on first install. See ARCHITECTURE.md § Tray distribution for the install-doc
that IT must provide.

v1.1 work item: enrol in Apple Developer Program + procure Windows EV cert,
flip `forceCodeSigning: true` in `electron-builder.yml`, and wire signing in CI.
