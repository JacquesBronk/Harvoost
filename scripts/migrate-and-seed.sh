#!/usr/bin/env bash
# scripts/migrate-and-seed.sh
# One-shot DB bootstrap for the docker compose `migrate` service.
#
# 1) Waits until Postgres accepts connections.
# 2) Applies all pending Prisma migrations (idempotent).
# 3) Seeds the dev fixture (idempotent — upserts on stable keys).
#
# Exits non-zero on any step failure so compose marks the dependent
# services (api, web) as not-ready and operators see the failure.

set -euo pipefail

cd /app

log() { printf '[migrate+seed] %s\n' "$*"; }

if [[ -z "${DATABASE_URL:-}" ]]; then
  log "FATAL: DATABASE_URL not set"
  exit 1
fi

# Parse host:port out of the DATABASE_URL for the wait loop.
# Format: postgresql://user:pass@host:port/db?...
host_port=$(printf '%s' "$DATABASE_URL" | sed -E 's|^[a-z]+://[^@]+@([^/]+)/.*|\1|')
host="${host_port%:*}"
port="${host_port##*:}"

log "waiting for postgres at ${host}:${port}..."
deadline=$((SECONDS + 60))
until (echo > "/dev/tcp/${host}/${port}") 2>/dev/null; do
  if (( SECONDS >= deadline )); then
    log "FATAL: postgres unreachable after 60s"
    exit 1
  fi
  sleep 1
done
log "postgres reachable"

log "applying migrations..."
pnpm --filter @harvoost/db migrate:deploy

log "seeding fixture..."
pnpm --filter @harvoost/db seed

log "done."
