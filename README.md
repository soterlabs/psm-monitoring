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

The dashboard charts daily on-chain snapshots for the last 7, 30, 90, or 180 days and monthly snapshots from January 2025 onward. History is reconstructed from archive RPC reads at startup and refreshed every six hours.

The same dashboard also shows USDC-equivalent capacity across Grove and Spark SDE venues, both per venue and in aggregate. It includes daily history from January 2026, month-end history, and live chain-by-chain verification of USDC held by the Base, Arbitrum, Optimism, and Unichain PSM3 contracts. See [DIRECT_EXPOSURE.md](DIRECT_EXPOSURE.md) for its scope, calculation, and liquidity caveats.

See [MONITORING_PLAN.md](MONITORING_PLAN.md) for the monitoring and response plan.
See [ARCHITECTURE.md](ARCHITECTURE.md) for a concise explanation of the pocket, LitePSM, USDS PSM Wrapper, and DAI–USDS converter.

## Endpoints

- `/` — live dashboard, refreshed every 30 seconds
- `/api/status` — machine-readable status and most recent RPC error
- `/api/history?range=30d` — daily history (`7d`, `90d`, `180d`, and `monthly` are also available)
- `/direct-exposure` — compatibility URL for the consolidated dashboard
- `/api/direct-exposure?range=30d` — per-venue history (`7d`, `90d`, `ytd`, and `monthly` are also available)
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

The repository includes a production `Dockerfile` and Railway infrastructure-as-code in `.railway/railway.ts`. Create a Railway service from this GitHub repository, set `ETH_RPC`, and run `railway config apply`. Railway supplies `PORT` automatically.

Optional alerting works with generic JSON, Slack, or Discord webhooks:

```text
ALERT_WEBHOOK_URL=https://...
```

The webhook receives an alert on entry into a warning state, on severity changes, after recovery, and hourly while an alert persists. Change `ALERT_REMINDER_SECONDS` to adjust reminders.

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
| `ALERT_WEBHOOK_URL` | no | — | Alert destination |
| `ALERT_REMINDER_SECONDS` | no | `3600` | Re-alert interval; minimum 60 |
| `SETTLEMENT_API_URL` | no | public settle API | Override the SDE daily-data service |
| `BASE_RPC` | yes for PSM3 verification | — | Base JSON-RPC URL |
| `ARBITRUM_RPC` | yes for PSM3 verification | — | Arbitrum JSON-RPC URL |
| `OPTIMISM_RPC` | yes for PSM3 verification | — | Optimism JSON-RPC URL |
| `UNICHAIN_RPC` | yes for PSM3 verification | — | Unichain JSON-RPC URL |

Secrets are runtime configuration only. `.env` files are ignored by git.

## License

MIT
