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

The dashboard charts daily on-chain snapshots for the last 7, 30, 90, or 180 days and monthly snapshots from January 2025 onward. A Railway cron service refreshes both chart datasets every day at 02:15 UTC and upserts them into Railway Postgres. The web process loads history from Postgres on request; on an empty database it reconstructs and seeds the history automatically, with archive RPC reads as the storage fallback.

Between the reserve and refill-capacity sections, **Top net USDC withdrawers** ranks the 20 addresses with the largest positive **USDC withdrawn minus USDC replenished** over rolling 1, 7, 30, 90, or 180 days. Amounts are summed exactly before sorting and display rounding. Net suppliers and addresses that fully replenished their withdrawals are omitted. Amount tooltips show gross withdrawals and replenishments separately. Each proxy remains a separate address, with labels checked against [Spark's Ethereum registry](https://github.com/sparkdotfi/spark-address-registry/blob/master/src/Ethereum.sol) and [Grove's registry](https://github.com/grove-labs/grove-address-registry/blob/master/src/Ethereum.sol).

Net flow indexing uses canonical USDC `Transfer` events into and out of the LitePSM pocket and contract; transfers within that reserve pair are excluded. Counterparties are the USDC recipients and funding addresses. The canonical USDS wrapper pulls USDC from its caller before forwarding it to the pocket: chronological wrapper funding is attributed to that caller, so ALM proxies receive credit for their replenishments. Unmatched wrapper inventory remains attributed to the wrapper. Other routers can represent multiple users; the ranking does not infer ultimate beneficial ownership or merge related addresses.

Indexing uses `ENVIO_API_TOKEN` for HyperSync and `ETH_RPC` for finalized Ethereum blocks and PSM token/pocket verification. Only transfers involving the reserves or canonical wrapper are requested. Postgres stores signed flows and a resumable cursor in `psm_usdc_flow_events` and `psm_usdc_flow_index`; old gross-only withdrawal caches are separate and never qualify as net coverage. Inserts and cursor advances are atomic and competing workers cannot overwrite progress. Backfill establishes the latest day first, then 7 and 30 days, then older history in bounded chunks. A range becomes available only after the entire selected period is covered, including periods with no net withdrawers. The period ends at the latest fully indexed finalized block, with an explicit as-of time. Without Postgres, local development uses an in-memory cache that resets on restart. No chain transaction is sent.

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
- `/api/withdrawals?range=7d` — top 20 positive net USDC withdrawers (`1d`, `7d`, `30d`, `90d`, `180d`); `202` while the requested period is still loading, `503` if unavailable, and `400` for unsupported ranges
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

The repository includes a production `Dockerfile` and Railway infrastructure-as-code in `.railway/railway.ts`. It declares a serverless web service, persistent Postgres, the `daily-snapshots` cron, and the ten-minute Slack alert cron. The web service performs no background polling: dashboard and API requests refresh live readings on demand, allowing Railway to sleep it while unused. The first request after sleep may require a retry during Railway's cold start. Set `ETH_RPC` on the web service and run `railway config apply`; the workers reference the required secrets. Railway supplies `PORT` automatically.

For withdrawal rankings, also set `ENVIO_API_TOKEN` on the web service. The infrastructure declaration adds `psm-withdrawals`, a ten-minute cron running `npm run withdrawals:sync`, with references to the same RPC, token and database. On first deployment the worker backfills 180 days; subsequent runs catch up to the latest finalized block. Covered rankings return immediately while indexing refreshes in the background. Initial requests wait at most eight seconds before returning a loading response; later requests resume the same in-flight work. Provider throttling retries briefly; if it persists, the next request or cron resumes at the last committed cursor. To seed manually, build the project and run `npm run withdrawals:sync` with those three variables available. No production database credentials or indexer tokens belong in source control.

Slack policy uses the PSM USDC reserve divided by **circulating USDS + DAI**, fetched for each check from [BA Labs' Sky supply API](https://sky.data.blockanalitica.com/internal/supply/). This differs from raw USDS issuance and sUSDS vault TVL. It also differs from the dashboard's separately configured `LIMIT_USDC` operational target. Invalid or unavailable supply stops that alert check without advancing its state; no cached denominator is substituted.

Optional Slack alerting uses an Incoming Webhook:

```text
SLACK_WEBHOOK_URL=https://hooks.slack.com/services/...
```

The dedicated `slack-psm-alerts` Railway cron evaluates the reserve ratio every ten minutes. Downward crossings below **30%** and **28%** send untagged messages; below **25%** sends `@here` and the SFF internal-reaction callout; below **20%** sends `🚨 ACTION NEEDED`, `@here`, and the urgent SFF refill callout. A recovery to at least 30% sends an untagged recovery. The twelve-hour information update and greater-than-10M consecutive-check drop note remain untagged. Set optional `SLACK_SFF_MENTION` on the Slack cron to a real Slack user/group token to ping SFF directly; otherwise the existing SFF wording is retained. A separate `slack_ratio_alert_state` table seeds the new policy once with a healthy band and the previous balance/message-delivery history. The legacy worker’s table and bands remain intact during rollout. See [SLACK_SETUP.md](SLACK_SETUP.md).


## Configuration

| Variable | Required | Default | Purpose |
| --- | --- | --- | --- |
| `ETH_RPC` | yes | — | Ethereum mainnet JSON-RPC URL |
| `ENVIO_API_TOKEN` | required for withdrawal rankings | — | Envio HyperSync token for the web service and withdrawal indexing worker |
| `PSM_ADDRESS` | no | `0xf6e72...53042` | LitePSM contract |
| `USDC_ADDRESS` | no | `0xA0b869...6eB48` | Expected gem/token |
| `LIMIT_USDC` | no | `4000000000` | Minimum healthy target |
| `YELLOW_PERCENT` | no | `95` | Yellow threshold below target |
| `ORANGE_PERCENT` | no | `90` | Orange threshold; lower values are red |
| `POLL_INTERVAL_SECONDS` | no | `60` | On-chain polling cadence; minimum 10 |
| `STALE_AFTER_SECONDS` | no | `180` | Reading age that fails readiness |
| `SLACK_WEBHOOK_URL` | no | — | Secret Slack Incoming Webhook URL |
| `SLACK_SFF_MENTION` | no | existing SFF text | Optional actual Slack user/group mention token on the Slack cron, e.g. `<!subteam^S0123456789>` |
| `ALERT_WEBHOOK_URL` | no | — | Legacy generic webhook; do not point it at the same Slack channel |
| `ALERT_REMINDER_SECONDS` | no | `3600` | Legacy generic-webhook reminder interval |
| `SETTLEMENT_API_URL` | no | public settle API | Override the SDE daily-data service |
| `SKY_DATA_API_URL` | no | BA Labs public Sky Data API | Override Basin JTRSY history and the circulating-supply API for alerts |
| `BASE_RPC` | yes for PSM3 verification | — | Base JSON-RPC URL |
| `ARBITRUM_RPC` | yes for PSM3 verification | — | Arbitrum JSON-RPC URL |
| `OPTIMISM_RPC` | yes for PSM3 verification | — | Optimism JSON-RPC URL |
| `UNICHAIN_RPC` | yes for PSM3 verification | — | Unichain JSON-RPC URL |
| `DATABASE_URL` | required for persistent history | — | Railway Postgres URL shared by web, snapshot, Slack and withdrawal indexing services |

Secrets are runtime configuration only. `.env` files are ignored by git.

## License

MIT
