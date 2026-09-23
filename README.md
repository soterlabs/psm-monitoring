# PSM Monitoring

Live, read-only monitoring for the [Sky LitePSM USDC-A](https://etherscan.io/address/0xf6e72Db5454dd049d0788e411b06CfAF16853042) on Ethereum mainnet.

**Live dashboard:** [psm-monitoring-production.up.railway.app](https://psm-monitoring-production.up.railway.app)

The service reads the PSM's configured `pocket()` and `gem()` on-chain, verifies that the gem is Ethereum USDC, and adds:

```text
USDC.balanceOf(pocket) + USDC.balanceOf(PSM)
```

It compares that balance with a 4 billion USDC minimum target. Defaults are:

- `healthy` (green): 100% or more
- `warning` (yellow): 95% to below 100%
- `critical` (orange): 90% to below 95%
- `low` (red): below 90%

The dashboard charts daily on-chain snapshots for the last 7, 30, 90, or 180 days and monthly snapshots from January 2025 onward. A Railway cron service refreshes both chart datasets every day at 02:15 UTC and upserts them into Railway Postgres. On an empty database, the web service reconstructs and seeds the history automatically; archive RPC reads remain the fallback if storage is unavailable.

The same dashboard also shows USDC-equivalent capacity across Grove and Spark SDE venues, both per venue and in aggregate. Its reviewed daily history begins in January 2025, is zero before the first SDE designation on 23 October 2025, and applies each later Atlas scope transition on its effective date. The immutable data is kept in [`src/data/sde-history.json`](src/data/sde-history.json); the live service extends it after the reviewed cutoff. The dashboard also provides month-end history and live chain-by-chain verification of USDC held by the Base, Arbitrum, Optimism, and Unichain PSM3 contracts. See [DIRECT_EXPOSURE.md](DIRECT_EXPOSURE.md) for its scope, calculation, and liquidity caveats.

See [MONITORING_PLAN.md](MONITORING_PLAN.md) for the monitoring and response plan.
See [ARCHITECTURE.md](ARCHITECTURE.md) for a concise explanation of the pocket, LitePSM, USDS PSM Wrapper, and DAI–USDS converter.

## Endpoints

- `/` — live dashboard, refreshed every 30 seconds
- `/api/status` — machine-readable status and most recent RPC error
- `/api/history?range=30d` — daily history (`7d`, `90d`, `180d`, and `monthly` are also available)
- `/direct-exposure` — compatibility URL for the consolidated dashboard
- `/api/direct-exposure?range=30d` — per-venue history (`7d`, `90d`, `ytd`, `all`, and `monthly` are also available)
- `/api/psm3` — live PSM3 USDC reserves and Spark ownership by L2
- `/metrics` — Prometheus metrics for LitePSM health and aggregate SDE capacity
- `/healthz` — process liveness (Railway health check)
- `/readyz` — `200` only when an on-chain reading is fresh

## Run locally

Requires Node.js 22+ and an Ethereum mainnet RPC URL.

```bash
cp .env.example .env
# Set ETH_RPC in .env, then:
set -a && source .env && set +a
npm install
npm run dev
```

Validate changes with:

```bash
npm run typecheck
npm test
npm run build
```

## Deploy to Railway

The repository includes a production `Dockerfile` and Railway infrastructure-as-code in `.railway/railway.ts`. It declares the web service, a persistent Postgres database, and the `daily-snapshots` cron worker. Set `ETH_RPC` on the web service and run `railway config apply`; the worker references the same secret and runs `npm run cron` at 02:15 UTC. Railway supplies `PORT` automatically.

Optional Slack alerting uses an Incoming Webhook:

```text
SLACK_WEBHOOK_URL=https://hooks.slack.com/services/...
```

The dedicated `slack-psm-alerts` Railway cron evaluates the PSM balance every ten minutes, applies the 3.95B/3.90B/3.85B/3.80B escalation policy, alerts immediately on state changes, repeats an active alert hourly, and sends an untagged note for a greater-than-10M drop between consecutive checks. See [SLACK_SETUP.md](SLACK_SETUP.md) for the Slack and Railway setup procedure.

## Configuration

| Variable | Required | Default | Purpose |
| --- | --- | --- | --- |
| `ETH_RPC` | yes | — | Ethereum mainnet JSON-RPC URL |
| `PSM_ADDRESS` | no | `0xf6e72...53042` | LitePSM contract |
| `USDC_ADDRESS` | no | `0xA0b869...6eB48` | Expected gem/token |
| `LIMIT_USDC` | no | `4000000000` | Minimum healthy target |
| `YELLOW_PERCENT` | no | `95` | Yellow threshold below target |
| `ORANGE_PERCENT` | no | `90` | Orange threshold; lower values are red |
| `POLL_INTERVAL_SECONDS` | no | `60` | On-chain polling cadence; minimum 10 |
| `STALE_AFTER_SECONDS` | no | `180` | Reading age that fails readiness |
| `SLACK_WEBHOOK_URL` | no | — | Secret Slack Incoming Webhook URL |
| `SLACK_REMINDER_SECONDS` | no | `3600` | Active-alert reminder interval; minimum 60 |
| `ALERT_WEBHOOK_URL` | no | — | Legacy generic webhook; do not point it at the same Slack channel |
| `ALERT_REMINDER_SECONDS` | no | `3600` | Legacy generic-webhook reminder interval |
| `SETTLEMENT_API_URL` | no | public settle API | Override the SDE daily-data service |
| `SKY_DATA_API_URL` | no | BA Labs public Sky Data API | Override the Basin JTRSY history service |
| `BASE_RPC` | yes for PSM3 verification | — | Base JSON-RPC URL |
| `ARBITRUM_RPC` | yes for PSM3 verification | — | Arbitrum JSON-RPC URL |
| `OPTIMISM_RPC` | yes for PSM3 verification | — | Optimism JSON-RPC URL |
| `UNICHAIN_RPC` | yes for PSM3 verification | — | Unichain JSON-RPC URL |
| `DATABASE_URL` | required for persistent history | — | Railway Postgres connection URL shared by the web and daily snapshot services |

Secrets are runtime configuration only. `.env` files are ignored by git.

## License

MIT
