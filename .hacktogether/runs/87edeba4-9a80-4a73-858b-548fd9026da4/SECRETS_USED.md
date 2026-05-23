# Secrets used by this run

Source of truth: `02-architecture/STACK.md` § Required secrets, with r2 LLM defaults applied.

## Required (production deploy)

These MUST be real, non-placeholder values before deploying to Azure. Local dev can run without them via fallbacks.

| Env var | Purpose | Status in `.hacktogether/secrets.local.md` |
|---|---|---|
| `ENTRA_TENANT_ID` | Azure AD tenant for OIDC | ✗ `__REPLACE_ME__` |
| `ENTRA_CLIENT_ID` | Entra app registration client id | ✗ `__REPLACE_ME__` |
| `ENTRA_CLIENT_SECRET` | Entra app registration client secret | ✗ `__REPLACE_ME__` |
| `DATABASE_URL` | Postgres connection | ✓ dev value (docker-compose Postgres) |
| `BLOB_STORAGE_CONNECTION_STRING` | Azure Blob Storage | ✓ dev value (Azurite emulator) |
| `APPINSIGHTS_CONNECTION_STRING` | App Insights ingestion | ✗ `__REPLACE_ME_OR_LEAVE_BLANK_FOR_DEV__` |
| `LLM_PROVIDER` | Active LLM provider | ✓ `openai` (r2 default) |
| `LLM_MODEL_ID` | LLM model | ✓ `gpt-4o` (r2 default) |
| `OPENAI_API_KEY` | OpenAI API key (since `LLM_PROVIDER=openai`) | ✗ `__REPLACE_ME__` |
| `ACS_EMAIL_CONNECTION_STRING` | Azure Communication Services Email | ✗ `__REPLACE_ME_OR_LEAVE_BLANK_FOR_DEV__` |
| `ACS_EMAIL_SENDER_ADDRESS` | From-address for outbound mail | ✓ dev value (`noreply@harvoost.local`) |
| `SESSION_SECRET` | HMAC for session tokens (32+ bytes) | ⚠ dev placeholder (regenerate for prod) |
| `AUDIT_HASH_SECRET` | HMAC for audit-log hash chain (32+ bytes) | ⚠ dev placeholder (regenerate for prod) |
| `BOOTSTRAP_ADMIN_EMAIL` | First-admin allowlist email | ✓ dev value (`admin@harvoost.local`) — set to your email for prod |
| `CORS_ALLOWED_ORIGINS` | Web app origin allowlist | ✓ dev value (`http://localhost:3000`) |

## Optional (only if `LLM_PROVIDER` is overridden away from openai)

These are commented out in `secrets.local.md` and only need to be filled if you set `LLM_PROVIDER` to that provider:

- `ANTHROPIC_API_KEY` (`LLM_PROVIDER=anthropic`)
- `GOOGLE_GENERATIVE_AI_API_KEY` (`LLM_PROVIDER=google`)
- `XAI_API_KEY` (`LLM_PROVIDER=xai`)
- `OLLAMA_BASE_URL` (`LLM_PROVIDER=ollama`)

## Local-dev runnability

With `__REPLACE_ME__` placeholders, the **local-dev stack still runs** because:
- Postgres comes from docker-compose
- Blob storage comes from Azurite
- Email captures to Maildev (`http://localhost:1080`)
- App Insights is disabled (logs to stdout)
- LLM uses `mock` provider if `OPENAI_API_KEY` is the literal `__REPLACE_ME__` → switch to `LLM_PROVIDER=mock` for fully-offline dev, OR install Ollama locally and use `LLM_PROVIDER=ollama`

For **production deploy**, the build will refuse to start if `__REPLACE_ME__` appears in any required field.

## Status summary

- **Build-blocking secrets:** none (dev fallbacks cover everything)
- **Deploy-blocking placeholders:** 5 critical (`ENTRA_*` x3, `OPENAI_API_KEY`, `ACS_EMAIL_CONNECTION_STRING`) + 2 must-rotate (`SESSION_SECRET`, `AUDIT_HASH_SECRET`)
- **Gate disposition:** awaiting user decision — proceed with dev fallbacks (recommended for build phase; supply real values later via Azure Key Vault) OR provide real values now.
