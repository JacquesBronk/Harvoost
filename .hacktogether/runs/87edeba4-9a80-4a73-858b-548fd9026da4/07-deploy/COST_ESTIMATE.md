# Cost estimate — Harvoost Azure deployment

Rough monthly USD estimates for the three environments. Use the Azure pricing
calculator for committed numbers — these are order-of-magnitude figures for
planning. **South Africa North pricing is not always documented; some
estimates extrapolate from West Europe / North Europe.**

> Assumptions:
> - Single-AZ deployment, no HA.
> - Container Apps Consumption profile (per-second billing).
> - Outbound bandwidth modest (no large media; XLSX exports the largest objects).
> - Chatbot LLM token spend billed separately by the LLM provider — NOT included below.

## Per-resource estimates

### Postgres Flexible Server

| Env | SKU | vCPU | RAM | Storage | Backup | Geo-redundant | Monthly |
|---|---|---|---|---|---|---|---|
| dev | Standard_B1ms | 1 | 2 GiB | 32 GiB | 7d | No | ~$15 |
| staging | Standard_B2ms | 2 | 4 GiB | 32 GiB | 7d | No | ~$30 |
| prod | Standard_B2ms | 2 | 4 GiB | 64 GiB | 14d | Yes (SAW) | ~$60 |

If prod load demands Standard_D2s_v3 (2 vCPU / 8 GiB General Purpose), the monthly cost roughly doubles to ~$130.

### Container Apps

Consumption profile: $0.000024/vCPU-sec + $0.000003/GiB-sec + $0.40 per million requests after the free tier.

| Env | Replica counts (api/worker/web) | Estimated active hours/day | Monthly |
|---|---|---|---|
| dev | 1 / 1 / 1, low traffic | ~6h workload-equivalent | ~$10 |
| staging | 1 / 1 / 1, smoke-test traffic | ~10h workload-equivalent | ~$25 |
| prod | 2-5 / 1-3 / 2-4, business hours | varies; assume 24h baseline | ~$80 |

The first 180k vCPU-sec and 360k GiB-sec per month are free, which covers most of dev's footprint outright.

### Azure Blob Storage

| Env | SKU | Used storage | Egress | Monthly |
|---|---|---|---|---|
| dev | Standard_LRS | <5 GiB | minimal | <$2 |
| staging | Standard_LRS | <5 GiB | minimal | ~$3 |
| prod | Standard_GRS | <20 GiB (mostly exports) | modest | ~$10 |

GRS roughly doubles the storage line vs LRS. If exports retention is later trimmed to <24h, costs drop further.

### Application Insights + Log Analytics

| Env | Daily ingest cap | Monthly |
|---|---|---|
| dev | ~200 MB | ~$5 |
| staging | ~500 MB | ~$10 |
| prod | ~1.5 GiB | ~$30 |

App Insights is billed per GiB ingested (~$2.30/GiB after the 5 GiB free tier) + retention beyond 90 days. The estimates above assume default sampling (100% errors, 25% traces — set by app, not infra).

### Azure Container Registry

Basic SKU: $5/month flat (includes 10 GiB storage). Same across all envs.

### Azure Key Vault

Standard tier: free for the first 10,000 operations/month; ~$0.03 per 10,000 secret operations after. Container Apps' Key Vault refs are infrequent (boot-time + secret-rotation events). Effective cost: **~$0**.

### Azure Communication Services Email

Pay-per-use: ~$0.00025 per email (250 micro-USD). Even at 1,000 weekly summaries/week + leave notifications, you're well under $5/month for prod. Sender-domain verification is free.

## Totals (excluding LLM spend)

| Env | Monthly |
|---|---|
| dev | **~$40** |
| staging | **~$75** |
| prod | **~$190** |

## OpenAI (LLM) — separate bill

Default `LLM_PROVIDER=openai`, `LLM_MODEL_ID=gpt-4o` for prod.

| Scenario | Estimated spend |
|---|---|
| dev/CI on `gpt-4o-mini` | <$5/month (capped at `chatbot_daily_token_budget=50k`/user, low user count) |
| prod with 50 active users, 20 chatbot prompts/user/day, gpt-4o | ~$60-120/month (depends heavily on prompt + tool-output size) |
| Weekly-summary prose generation | <$5/month even at 100 users/week |

OpenAI is the largest variable cost; budget review is recommended after the first month of real traffic.

## Cost optimisation knobs (when needed)

- **Postgres**: drop to B1ms for non-prod; turn off auto-grow if storage is stable.
- **Container Apps**: tighten scale rules; allow min-replicas to drop to 0 for ca-worker (cold-start is OK for pg-boss, but cron jobs need a warm worker).
- **App Insights**: lower trace sampling to 10%; tighten retention to 30 days for non-prod.
- **Blob**: lifecycle policy → move exports to Cool tier after 1 day, delete after 7.
- **LLM**: switch to gpt-4o-mini for prod if quality is acceptable (~10x cheaper).
- **Geo-redundant backup**: disable on prod ONLY if business accepts the regional-outage risk — saves ~$15/month on Postgres.
