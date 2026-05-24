---
phase: incidents/INC-008
agent: devops
started: 2026-05-24
finished: 2026-05-24
status: complete
---

# Summary
Implemented the REALM/CONFIG lane of INC-008 (#11 — OIDC RP-initiated logout). The
`harvoost-web` Keycloak client only allowlisted the 3 callback URIs for post-logout
(`post.logout.redirect.uris: "+"` inherits Valid Redirect URIs), so the backend's
`post_logout_redirect_uri=http://localhost:3000/login` would be rejected and the user
would land on Keycloak's generic "signed out" page. I added `http://localhost:3000/login`
(plus the origin root) to the client's post-logout allowlist, left the login redirect
URIs / client secret / `harvoost-tray` untouched (INC-002 preserved), performed the
volume-drop re-import (docker was available), and confirmed the live client now carries
the new URI. I also documented the prod Microsoft Entra equivalent in DEPLOY_READINESS.md
and updated the Keycloak README's re-import runbook to flag that realm.json edits require
the volume drop.

# Files touched
- infra/keycloak/realm.json (modified) — `harvoost-web` client `post.logout.redirect.uris`: `"+"` → `"+##http://localhost:3000/login##http://localhost:3000"`. `+` keeps inheritance of the 3 valid redirect (callback) URIs; `##` is Keycloak's multi-value delimiter; explicitly adds the web `/login` and origin root. redirectUris, secret, and `harvoost-tray` unchanged.
- infra/keycloak/README.md (modified) — "Resetting the realm" section: switched to `docker compose rm -sf keycloak`, added a callout that editing `realm.json` requires this exact volume-drop re-import (existing volume won't pick up edits), with INC-008 as the worked example.
- .hacktogether/runs/87edeba4-9a80-4a73-858b-548fd9026da4/07-deploy/DEPLOY_READINESS.md (modified) — "Infra readiness": added the prod Entra App Registration post-logout-URI requirement (Authentication → Front-channel logout URL + register `https://<web-fqdn>/login` in the redirect URI list). "First-deploy verifications": added a Sign Out smoke check that the browser returns to `/login`.

# What downstream agents need to know
- **Exact realm change:** `harvoost-web` → `attributes.post.logout.redirect.uris` = `+##http://localhost:3000/login##http://localhost:3000`. The leading `+` is load-bearing: it keeps the existing callback URIs valid as post-logout targets (don't drop it). Backend must send `post_logout_redirect_uri=http://localhost:3000/login` exactly (matched literally by Keycloak).
- **Re-import: DONE.** I ran the volume drop + re-import (docker 29.4.3 available, container was `Up 29 hours (healthy)` before). Volume name: **`harvoost-keycloak-data`**. Command sequence executed:
  ```
  docker compose rm -sf keycloak
  docker volume rm harvoost-keycloak-data
  docker compose up -d keycloak
  ```
  Keycloak came back healthy in ~10s, realm import logged "Import finished successfully", and api/web (which depend on keycloak) stayed healthy.
- **Provider-agnostic logout / prod note location:** added to `07-deploy/DEPLOY_READINESS.md` (Infra readiness section, right after the federated-credential item, + a verification line in First-deploy verifications). For PROD (Entra) the prod web `/login` URL must be registered on the App Registration (Front-channel logout URL + redirect URI list), mirroring this realm change.
- I did NOT touch `apps/*`, `openapi.yaml`, `tests/contract`, `.github/`, or compose. Stayed in `infra/keycloak/*` + deploy docs per guardrails.

# Open questions / unknowns
- None blocking. Note: the backend (apps/api logout URL builder) + frontend (handleSignOut navigation) are the parallel lanes and are required for the full fix — the realm change alone only makes Keycloak *accept* the `/login` post-logout redirect; it does not by itself trigger RP-initiated logout. End-to-end acceptance ("Sign Out → can log in as a different user") depends on those lanes landing too.

# Verification evidence
- `python3 -c "json.load(...)"` on realm.json → JSON valid; `harvoost-web` post.logout = `+##http://localhost:3000/login##http://localhost:3000`; redirectUris unchanged (3 callbacks); `harvoost-tray` post.logout still `+`.
- `docker compose config -q` → COMPOSE CONFIG OK (no YAML/compose errors).
- volume-drop re-import → `Realm 'harvoost' imported` + `KC-SERVICES0032: Import finished successfully`, no errors/exceptions in import logs.
- `docker inspect harvoost-keycloak .State.Health.Status` → `healthy` (3rd poll, ~10s).
- `curl .../.well-known/openid-configuration` → `end_session_endpoint: http://harvoost.localhost:8080/realms/harvoost/protocol/openid-connect/logout` (RP-initiated logout endpoint live).
- `kcadm get clients -r harvoost` → live `harvoost-web` client shows `post.logout.redirect.uris = +##http://localhost:3000/login##http://localhost:3000`; redirectUris intact; `harvoost-tray` untouched (`+`).
- `docker compose ps` → harvoost-keycloak/api/web/postgres all `healthy` after re-import (no regression).
