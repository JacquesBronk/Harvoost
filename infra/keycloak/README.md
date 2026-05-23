# Keycloak (dev OIDC IdP)

Per [ADR-0001](../../.hacktogether/runs/87edeba4-9a80-4a73-858b-548fd9026da4/02-architecture/ADR-0001-oidc-provider-agnostic.md), Harvoost's identity layer is provider-agnostic OIDC. The same `apps/api` code path validates id_tokens against whatever issuer `OIDC_ISSUER_URL` points to. In dev, that's a Keycloak container started by `docker-compose.yml`. In prod, it's Microsoft Entra ID.

Running the dev Keycloak means the real OIDC handshake is exercised end-to-end locally and in CI — the first time real OIDC runs is no longer the first production deploy.

## What this directory contains

| File | Purpose |
|---|---|
| `realm.json` | Keycloak realm export. Imported on first container start via `--import-realm`. Defines the `harvoost` realm, two OIDC clients, and seven fixture users. |
| `README.md` | This file. |

## Starting Keycloak

```bash
docker compose up -d keycloak
```

The container boots in ~3 seconds, then takes another ~10 seconds to import the realm on first start. Wait for the healthcheck to go green:

```bash
docker compose ps keycloak
# wait until STATUS shows "healthy"
```

## Admin console

Open <http://localhost:8080/admin> in a browser. Log in with:

- **Username:** `admin`
- **Password:** `dev-admin-not-for-prod`

The admin console lets you inspect/modify the realm at runtime. If you change something via the UI and want it to stick across `docker compose down -v`, re-export the realm (Realm Settings → Action → Partial Export) and commit the result back to `realm.json`.

## OIDC configuration the app uses

| Setting | Dev value |
|---|---|
| `OIDC_ISSUER_URL` | `http://localhost:8080/realms/harvoost` |
| `.well-known/openid-configuration` | `http://localhost:8080/realms/harvoost/.well-known/openid-configuration` |
| `OIDC_CLIENT_ID` (web) | `harvoost-web` |
| `OIDC_CLIENT_SECRET` (web) | `dev-keycloak-client-secret-not-for-prod` |
| `OIDC_CLIENT_ID` (tray) | `harvoost-tray` (public client; PKCE only, no secret) |
| Authorization endpoint | `http://localhost:8080/realms/harvoost/protocol/openid-connect/auth` |
| Token endpoint | `http://localhost:8080/realms/harvoost/protocol/openid-connect/token` |
| JWKS URI | `http://localhost:8080/realms/harvoost/protocol/openid-connect/certs` |

## Clients seeded by `realm.json`

### `harvoost-web` (confidential)

- For the Next.js web app at <http://localhost:3000>.
- Authorization-code flow + PKCE (S256) + client secret.
- Redirect URIs: `http://localhost:3000/v1/auth/callback`, `http://localhost:3001/v1/auth/callback`.
- Web origins (CORS): `http://localhost:3000`, `http://localhost:3001`.
- Direct access grants (password grant) are **disabled** — there is no shortcut to bypass the browser flow.

### `harvoost-tray` (public)

- For the Electron tray (`apps/tray`).
- Authorization-code flow + PKCE (S256), **no client secret** (Electron cannot safely keep one).
- Redirect URIs: `harvoost://auth/callback`, `harvoost-dev://auth/callback`.

## Seeded users

All passwords are obviously fake (`dev-XXX-pass`) so they cannot be mistaken for production credentials. They map onto the RBAC fixture seeded by `packages/db/prisma/seed.ts`.

| Email | Password | First/Last | Intended role in Harvoost | Use case |
|---|---|---|---|---|
| `admin@harvoost.local` | `dev-admin-pass` | Bootstrap Admin | `admin` (via `BOOTSTRAP_ADMIN_EMAIL` allowlist) | First login auto-provisions as admin. Use this account to demonstrate admin-only flows (allowlist, role assignment, financial dashboards). |
| `alice@harvoost.local` | `dev-alice-pass` | Alice Manager | `manager` | Manages a small team. Demonstrates project-anchored manager visibility cascade. |
| `finmgr@harvoost.local` | `dev-finmgr-pass` | Felix Finance | `financial_manager` | Sees cost/rate columns. Demonstrates financial-only short-circuit in `RbacScopeService`. |
| `bob@harvoost.local` | `dev-bob-pass` | Bob Employee | `employee` | Standard employee with timesheets + leave. |
| `carol@harvoost.local` | `dev-carol-pass` | Carol Employee | `employee` | Second employee for two-stage approval flows (Carol approves Bob, Alice does stage-2 — or similar). |
| `dave@harvoost.local` | `dev-dave-pass` | Dave Employee | `employee` | Third employee, used by e2e tests for cascade-visibility negative cases. |
| `eve@harvoost.local` | `dev-eve-pass` | Eve Employee | `employee` | Fourth employee. Used by mood k>=5 anonymity tests where we need a fifth team member to expose the aggregate. |

> Role-mapping note: Keycloak does NOT push roles into Harvoost. Per ADR-0001, Harvoost owns its role universe via the `user_roles` table + `admin_email_allowlist`. Keycloak's job is narrow: prove identity (return `sub` + `email`). The "Intended role in Harvoost" column above is what `packages/db/prisma/seed.ts` writes to `user_roles` when the seed runs.

## Resetting the realm

The realm is imported on first start and then persisted in the `keycloak-data` Docker volume (Keycloak's `dev-file` H2 store). Subsequent `docker compose up` calls do NOT re-import — your runtime changes survive.

To wipe and re-import from `realm.json`:

```bash
docker compose down keycloak
docker volume rm harvoost-keycloak-data
docker compose up -d keycloak
```

## Production note

Keycloak persistence in this setup uses `KC_DB=dev-file` (H2 file). This is **explicitly dev-only** — not suitable for production. Production Harvoost does not run Keycloak at all: it points at Microsoft Entra ID via `OIDC_ISSUER_URL=https://login.microsoftonline.com/<tenant-id>/v2.0`.

If a customer needs self-hosted OIDC in production, the supported path is to run a separate properly-configured Keycloak (Postgres backend, real TLS, HA replicas, hardened admin console) and just point `OIDC_ISSUER_URL` at it. No code changes are required.

## Dev passwords are DEV ONLY

Every password and client secret in `realm.json` starts with the literal word `dev-` so that:

1. They cannot accidentally be re-used in production. (`OIDC_CLIENT_SECRET` in prod will fail any naive `startsWith('dev-')` audit and is set via Key Vault rotation anyway.)
2. They are obviously fake to anyone reading them.

Do not change these to look real. Do not commit production credentials here.
