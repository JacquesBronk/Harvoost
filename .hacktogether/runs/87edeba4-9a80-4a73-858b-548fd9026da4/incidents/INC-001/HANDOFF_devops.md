---
phase: INC-001
agent: devops
started: 2026-05-23
finished: 2026-05-23
status: complete
---

# Summary

Fixed two latent infrastructure bugs in the `web` service surfaced by INC-001 triage (cause #4 in ROOT_CAUSE.md). Neither was the spinner root cause (that's the CSP nonce work in apps/web/), but both were worth correcting while the area was open:

1. **`harvoost-web` healthcheck false-negative.** Docker auto-sets `HOSTNAME` to the container ID; Next.js standalone reads `HOSTNAME` and binds to that single IP (the bridge IP). The in-container healthcheck `fetch('http://localhost:3000/')` resolves to `127.0.0.1:3000` and gets ECONNREFUSED, so the container reports `unhealthy` even though the host port-forward works. Fix: pin `HOSTNAME=0.0.0.0` in the compose `environment:` block (Dockerfile-level `ENV` would be overridden by Docker's auto-set value).
2. **`NEXT_PUBLIC_API_BASE_URL` not baked into the client bundle.** Compose was passing it only as runtime env, but `NEXT_PUBLIC_*` is webpack-DefinePlugin'd at `next build` time. The bundle was silently falling back to the source default in `apps/web/src/lib/env.ts`. Fix: pass it as a Docker build ARG, re-export as ENV before `pnpm build`, and feed it via `build.args` in compose. Default value matches the existing source default, so behavior on a plain `docker build` is unchanged.

# Files touched

- `/mnt/c/Projects/Harvoost/docker/Dockerfile.web` (modified) — added `ARG`/`ENV` for `NEXT_PUBLIC_API_BASE_URL` in the `build` stage before `pnpm build`.
- `/mnt/c/Projects/Harvoost/docker-compose.yml` (modified) — `web.build` switched short→long form with `args:`; `HOSTNAME: "0.0.0.0"` added to `web.environment`.

## Before/after of changed blocks

### `docker/Dockerfile.web` — `build` stage

Before (lines 28-35):
```dockerfile
FROM deps AS build
WORKDIR /repo
COPY apps/web ./apps/web
COPY packages/shared ./packages/shared
COPY packages/ui ./packages/ui

ENV NEXT_TELEMETRY_DISABLED=1
RUN pnpm --filter @harvoost/web build
```

After:
```dockerfile
FROM deps AS build
WORKDIR /repo
COPY apps/web ./apps/web
COPY packages/shared ./packages/shared
COPY packages/ui ./packages/ui

ENV NEXT_TELEMETRY_DISABLED=1

# NEXT_PUBLIC_* values are baked into the client bundle at build time by
# webpack's DefinePlugin — setting them only at runtime via docker-compose
# `environment:` has no effect on the compiled JS. We accept it as a build
# ARG and re-export as an ENV so `next build` sees it. The default keeps
# `docker build` working without an explicit --build-arg; docker-compose
# passes the canonical value via the `build.args` block.
ARG NEXT_PUBLIC_API_BASE_URL=http://localhost:3001
ENV NEXT_PUBLIC_API_BASE_URL=$NEXT_PUBLIC_API_BASE_URL

RUN pnpm --filter @harvoost/web build
```

### `docker-compose.yml` — `web` service header

Before (around lines 207-217):
```yaml
  web:
    build:
      context: .
      dockerfile: docker/Dockerfile.web
    image: harvoost-web:dev
    container_name: harvoost-web
    env_file: .env
    environment:
      # Override the .env PORT=3001 (which is the api's port).
      PORT: "3000"
      NEXT_PUBLIC_API_BASE_URL: http://localhost:3001
```

After:
```yaml
  web:
    build:
      context: .
      dockerfile: docker/Dockerfile.web
      args:
        # NEXT_PUBLIC_* must be present at `next build` time (webpack DefinePlugin
        # inlines them into the client bundle). Setting it only in `environment:`
        # below is too late — the bundle is already compiled. Keep both in sync:
        # build arg bakes it into the client JS; env var below feeds the running
        # server (e.g. next.config headers() / CSP connect-src).
        NEXT_PUBLIC_API_BASE_URL: http://localhost:3001
    image: harvoost-web:dev
    container_name: harvoost-web
    env_file: .env
    environment:
      # Override the .env PORT=3001 (which is the api's port).
      PORT: "3000"
      # Next.js standalone server reads HOSTNAME and binds to that single IP.
      # Docker auto-sets HOSTNAME to the container ID, which resolves to the
      # bridge IP only — so `fetch('http://localhost:3000/')` inside the
      # container hits 127.0.0.1:3000 and gets ECONNREFUSED, marking the
      # healthcheck (and therefore the container) unhealthy even though the
      # host-forwarded port works. Force 0.0.0.0 so the server listens on all
      # interfaces including loopback.
      HOSTNAME: "0.0.0.0"
      NEXT_PUBLIC_API_BASE_URL: http://localhost:3001
```

(All other `web` service fields — `ports`, `depends_on`, `restart`, `healthcheck`, `image`, `container_name`, `env_file` — were preserved verbatim.)

# What downstream agents need to know

- The parallel frontend-dev agent's CSP `connect-src` needs to read `NEXT_PUBLIC_API_BASE_URL` from `process.env` in `next.config.*`'s `headers()` (which runs server-side). That value is now sourced from compose's `environment:` block — unchanged from before this hotfix; the build-arg addition is strictly additive for the client bundle.
- The `web` service `build` block changed from short-form (just `build: ./docker/Dockerfile.web`-equivalent) to long-form with `args`. Anyone running `docker compose build web` will now get the build arg passed automatically. A plain `docker build -f docker/Dockerfile.web .` without `--build-arg` still works because the Dockerfile's `ARG` has a sane default.
- The `web.environment.HOSTNAME` override only affects the container's process namespace (it does not change the container's network hostname for DNS). It only steers Next.js's listen-address selection.
- **Out of scope but worth flagging for v0.2.0:** the comment block in `docker-compose.yml:14-22` is stale — it claims api/web/migrate use `network_mode: host`, but the current config uses bridge networking with port mappings. I did not rewrite it per the dispatch instruction. File this as a doc-cleanup task for v0.2.0.

# Open questions / unknowns

- None. The orchestrator will run `docker compose down && docker compose up -d --build` in the verify phase to confirm the rebuild bakes the bundle correctly and the healthcheck goes green.

# Verification evidence

- `docker compose config` → parses cleanly, no errors.
- `docker compose config 2>/dev/null | grep -E 'HOSTNAME|NEXT_PUBLIC_API_BASE_URL' -A1` output:
  ```
          NEXT_PUBLIC_API_BASE_URL: http://localhost:3001
      container_name: harvoost-web
  --
        HOSTNAME: 0.0.0.0
        LLM_MODEL_ID: gpt-4o
  --
        NEXT_PUBLIC_API_BASE_URL: http://localhost:3001
        NODE_ENV: development
  ```
  Match 1 is `web.build.args.NEXT_PUBLIC_API_BASE_URL` (build-time bake — new). Match 2 is `web.environment.HOSTNAME` (new). Match 3 is `web.environment.NEXT_PUBLIC_API_BASE_URL` (preserved for the runtime Next.js server). All three present in the resolved web service config.
- Full resolved `web` service block inspected — `container_name`, `image: harvoost-web:dev`, `depends_on.api.condition: service_healthy`, `ports: 127.0.0.1:3000:3000`, `restart: unless-stopped`, and the healthcheck command/timing all unchanged.

## Rollback

If verify-phase reveals an issue:

1. `git checkout HEAD -- docker/Dockerfile.web docker-compose.yml` to revert both files.
2. `docker compose down && docker compose up -d --build` to rebuild from the previous state.

Both changes are purely additive (new ARG/ENV/args block, new HOSTNAME env var) — reverting cannot break anything that was working before this hotfix.
