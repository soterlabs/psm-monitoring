# PSM Monitoring

Live, read-only monitoring for the [Sky LitePSM USDC-A](https://etherscan.io/address/0xf6e72Db5454dd049d0788e411b06CfAF16853042) on Ethereum mainnet.

**Live dashboard:** [psm.soterlabs.com](https://psm.soterlabs.com)

The service reads the PSM's configured `pocket()` and `gem()` on-chain, verifies that the gem is Ethereum USDC, and adds:

```text
USDC.balanceOf(pocket) + USDC.balanceOf(PSM)
```

The live reserve target is **30% of circulating USDS + DAI**. The reserve card and headline cards show the current reserve/supply ratio, the computed USDC target, and the surplus or shortfall against that target. They use the same exact ratio bands as Slack: healthy at or above 30%, warning from 28% to below 30%, critical from 25% to below 28%, and low below 25%, with an action-needed indication below 20%. A supply refresh failure marks the combined reading stale; the dashboard does not substitute a fixed 4B target.

The reserve chart uses rounded axis bounds and evenly spaced round-number ticks (for example, 2.5B, 2.6B, 2.7B), expanding the step for wider ranges. The dashboard charts daily on-chain snapshots for the last 7, 30, 90, or 180 days and monthly snapshots from January 2025 onward. A Railway cron service refreshes both chart datasets every day at 02:15 UTC and upserts them into Railway Postgres. The web process loads history from Postgres on request; on an empty database it reconstructs and seeds the history automatically, with archive RPC reads as the storage fallback.

Between the reserve and refill-capacity sections, **Top net USDC withdrawers** ranks the 20 addresses with the largest positive **USDC withdrawn minus USDC replenished** over rolling 1, 7, 30, 90, or 180 days. Amounts are summed exactly before sorting and displayed rounded to whole USDC; tooltips retain exact amounts. Full addresses link to Etherscan and a separate Label column retains known identities. Net suppliers and addresses that fully replenished their withdrawals are omitted. Amount tooltips show gross withdrawals and replenishments separately. Optional `ETHERSCAN_API_KEY` enriches unlabeled addresses with verified contract names in the background. These appear with a `Contract:` prefix and are code metadata, not ownership tags; generic proxy names and unverified addresses stay unlabeled. Results are cached for 24 hours (five minutes after provider failure), and lookup failures do not delay or fail rankings. The supplied API plan does not include Etherscan’s separate Pro Plus public-name-tag endpoint. Each proxy remains a separate address, with labels checked against [Spark's Ethereum registry](https://github.com/sparkdotfi/spark-address-registry/blob/master/src/Ethereum.sol) and [Grove's registry](https://github.com/grove-labs/grove-address-registry/blob/master/src/Ethereum.sol).

Net flow indexing uses canonical USDC `Transfer` events into and out of the LitePSM pocket and contract; transfers within that reserve pair are excluded. Counterparties are the USDC recipients and funding addresses. The canonical USDS wrapper pulls USDC from its caller before forwarding it to the pocket: chronological wrapper funding is attributed to that caller, so ALM proxies receive credit for their replenishments. Unmatched wrapper inventory remains attributed to the wrapper. Other routers can represent multiple users; the ranking does not infer ultimate beneficial ownership or merge related addresses.

Indexing uses `ENVIO_API_TOKEN` for HyperSync and `ETH_RPC` for finalized Ethereum blocks and PSM token/pocket verification. Only transfers involving the reserves or canonical wrapper are requested. Postgres stores signed flows and a resumable cursor in `psm_usdc_flow_events` and `psm_usdc_flow_index`; old gross-only withdrawal caches are separate and never qualify as net coverage. Inserts and cursor advances are atomic and competing workers cannot overwrite progress. Backfill establishes the latest day first, then 7 and 30 days, then older history in bounded chunks. A range becomes available only after the entire selected period is covered, including periods with no net withdrawers. The period ends at the latest fully indexed finalized block, with an explicit as-of time. Without Postgres, local development uses an in-memory cache that resets on restart. No chain transaction is sent.

The same dashboard also shows USDC-equivalent capacity across Grove and Spark SDE venues, both per venue and in aggregate. Its reviewed daily history begins in January 2025, is zero before the first SDE designation on 23 October 2025, and applies each later Atlas scope transition on its effective date. The immutable data is kept in [`src/data/sde-history.json`](src/data/sde-history.json); the live service extends it after the reviewed cutoff. The dashboard also provides month-end history and live chain-by-chain verification of USDC held by the Base, Arbitrum, Optimism, and Unichain PSM3 contracts. See [DIRECT_EXPOSURE.md](DIRECT_EXPOSURE.md) for its scope, calculation, and liquidity caveats.

See [MONITORING_PLAN.md](MONITORING_PLAN.md) for the monitoring and response plan.
See [ARCHITECTURE.md](ARCHITECTURE.md) for a concise explanation of the pocket, LitePSM, USDS PSM Wrapper, and DAI–USDS converter.

## Endpoints

- `/` — live dashboard, refreshed every 30 seconds
- `/api/status` — machine-readable status and most recent RPC error
- `/api/history?range=30d` — balance history with a per-point `targetUsdc` and an independent daily `targetPoints` curve (`7d`, `90d`, `180d`, and `monthly` are also available); unavailable targets and utilization are `null`
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

For withdrawal rankings, also set `ENVIO_API_TOKEN` on the web service. Optional `ETHERSCAN_API_KEY` belongs only on the web service for server-side contract-name enrichment. The infrastructure declaration adds `psm-withdrawals`, a ten-minute cron running `npm run withdrawals:sync`, with references to the same RPC, token and database. On first deployment the worker backfills 180 days; subsequent runs catch up to the latest finalized block. Covered rankings return immediately while indexing refreshes in the background. Initial requests wait at most eight seconds before returning a loading response; later requests resume the same in-flight work. A shared Postgres advisory lock prevents the web process and cron from issuing overlapping index requests. HTTP 429 pauses indexing without advancing the cursor: `Retry-After` (seconds or HTTP date) is honored with a minimum one-minute cooldown; missing or invalid headers use exponential backoff up to 30 minutes. `psm_usdc_flow_refresh` saves the cooldown and failure state across process restarts. Covered rankings stay available with their original as-of date and a provider-rate-limit notice; incomplete ranges show a paused state and poll less often. The next eligible refresh resumes at the committed cursor. A sustained provider quota limit still requires the quota to reset or the plan to change. To seed manually, build the project and run `npm run withdrawals:sync` with those three variables available. No production database credentials or indexer tokens belong in source control.

Slack policy uses the PSM USDC reserve divided by **circulating USDS + DAI**, fetched for each check from [BA Labs' Sky supply API](https://sky.data.blockanalitica.com/internal/supply/). This differs from raw USDS issuance and sUSDS vault TVL. The same denominator determines the dashboard’s 30% target and headline ratios. Historical targets are **4B USDC through November 3, 2026 (UTC)**, then **30% of each date’s circulating USDS + DAI from November 4**. The dated [supply history](https://sky.data.blockanalitica.com/internal/supply/historic/) supplies each daily value; today’s supply is never used to reconstruct earlier dates. `psm_daily_targets` persists the combined circulating supply, exact target rounded up to micro-USDC, source URL, fetch time, and provisional flag by UTC date. The daily worker backfills and refreshes this table before reconstructing balances; dashboard history requests also refresh it at most every 15 minutes. The provider’s current-date row is provisional; later dated history can finalize it or correct the same date. Historical values are daily provider snapshots, not supply at the exact Ethereum block of the balance sample. Missing daily supply leaves an explicit gap in the target line. Saved targets remain available during provider outages. Live headline cards and alerts continue to use the latest supply reading. Invalid or unavailable supply stops that alert check without advancing its state; no cached denominator is substituted.

Optional Slack alerting uses an Incoming Webhook:

```text
SLACK_WEBHOOK_URL=https://hooks.slack.com/services/...
```

The dedicated `slack-psm-alerts` Railway cron evaluates the reserve ratio every ten minutes. Downward crossings below **30%** and **28%** send untagged messages; below **25%** sends `@here` and the SFF internal-reaction callout; below **20%** sends `🚨 ACTION NEEDED`, `@here`, and the urgent SFF refill callout. A recovery to at least 30% sends an untagged recovery. The twelve-hour information update and greater-than-10M consecutive-check drop note remain untagged. Every Slack message includes the current USDC reserve as a percentage of the circulating USDS + DAI fetched for that check, including standalone balance-movement notes. Percentages use two decimal places, retaining extra precision when rounding would obscure a threshold crossing. Set optional `SLACK_SFF_MENTION` on the Slack cron to a real Slack user/group token to ping SFF directly; otherwise the existing SFF wording is retained. A separate `slack_ratio_alert_state` table seeds the new policy once with a healthy band and the previous balance/message-delivery history. The legacy worker’s table and bands remain intact during rollout. See [SLACK_SETUP.md](SLACK_SETUP.md).


## Configuration

| Variable | Required | Default | Purpose |
| --- | --- | --- | --- |
| `ETH_RPC` | yes | — | Ethereum mainnet JSON-RPC URL |
| `ENVIO_API_TOKEN` | required for withdrawal rankings | — | Envio HyperSync token for the web service and withdrawal indexing worker |
| `ETHERSCAN_API_KEY` | no | — | Server-side verified contract names for the Label column; public nametags need Pro Plus access |
| `PSM_ADDRESS` | no | `0xf6e72...53042` | LitePSM contract |
| `USDC_ADDRESS` | no | `0xA0b869...6eB48` | Expected gem/token |
| `LIMIT_USDC` | no | `4000000000` | Legacy history-generation comparison only; live target and alerts use 30% of circulating supply |
| `YELLOW_PERCENT` | no | `95` | Legacy history-generation setting; live warning begins below 30% of supply |
| `ORANGE_PERCENT` | no | `90` | Legacy history-generation setting; live critical begins below 28% of supply |
| `POLL_INTERVAL_SECONDS` | no | `60` | On-chain polling cadence; minimum 10 |
| `STALE_AFTER_SECONDS` | no | `180` | Reading age that fails readiness |
| `SLACK_WEBHOOK_URL` | no | — | Secret Slack Incoming Webhook URL |
| `SLACK_SFF_MENTION` | no | existing SFF text | Optional actual Slack user/group mention token on the Slack cron, e.g. `<!subteam^S0123456789>` |
| `ALERT_WEBHOOK_URL` | no | — | Legacy generic webhook; do not point it at the same Slack channel |
| `ALERT_REMINDER_SECONDS` | no | `3600` | Legacy generic-webhook reminder interval |
| `SETTLEMENT_API_URL` | no | public settle API | Override the SDE daily-data service |
| `SKY_DATA_API_URL` | no | BA Labs public Sky Data API | Override Basin JTRSY history and current/historical circulating-supply APIs |
| `BASE_RPC` | yes for PSM3 verification | — | Base JSON-RPC URL |
| `ARBITRUM_RPC` | yes for PSM3 verification | — | Arbitrum JSON-RPC URL |
| `OPTIMISM_RPC` | yes for PSM3 verification | — | Optimism JSON-RPC URL |
| `UNICHAIN_RPC` | yes for PSM3 verification | — | Unichain JSON-RPC URL |
| `DATABASE_URL` | required for persistent history | — | Railway Postgres URL shared by web, snapshot, Slack and withdrawal indexing services |

Secrets are runtime configuration only. `.env` files are ignored by git.

## License

MIT
