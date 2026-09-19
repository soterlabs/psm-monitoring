# LitePSM USDC Monitoring Plan

## Objective

Detect when USDC controlled by Ethereum Sky LitePSM USDC-A falls below the configured 4,000,000,000 USDC minimum target, while also detecting stale or invalid monitoring data.

## Signal and scope

Every 60 seconds the service reads one Ethereum block and:

1. Reads `pocket()` and `gem()` from LitePSM `0xf6e72Db5454dd049d0788e411b06CfAF16853042`.
2. Confirms the chain ID is Ethereum mainnet (`1`) and `gem()` is canonical USDC `0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48`.
3. Calculates `USDC.balanceOf(pocket) + USDC.balanceOf(PSM)` at that same block.
4. Compares the aggregate balance to the configured limit.

The pocket is included because the [LitePSM design](https://github.com/sky-ecosystem/dss-lite-psm) intentionally keeps gem liquidity in a separate `pocket` address. Looking only at the PSM contract would normally report zero USDC and miss the exposure.

See [ARCHITECTURE.md](ARCHITECTURE.md) for the contract-by-contract flow and the role of the USDS wrapper.

The 4B value is a minimum operational target supplied for this monitor. A balance at or above it is healthy. It is not inferred from, and should not be confused with, Sky's mutable on-chain debt-ceiling parameters.

## Thresholds

| State | Default condition | Action |
| --- | --- | --- |
| `healthy` (green) | `≥ 4.0B` (`≥100%`) | No action |
| `warning` (yellow) | `3.8B–<4.0B` (`95–<100%`) | Review the balance trend and planned flows |
| `critical` (orange) | `3.6B–<3.8B` (`90–<95%`) | Notify the responsible risk/operator channel and prepare mitigation |
| `low` (red) | `< 3.6B` (`<90%`) | Escalate immediately; validate the reading independently and execute the approved response playbook |

Threshold percentages and the limit are environment-configurable. Changing them should be reviewed like a monitoring-policy change.

## Delivery and reliability

- Dashboard and `/api/status` expose the latest result.
- `/api/history` and the dashboard chart expose 90- and 180-day daily snapshots plus monthly snapshots from January 2025 onward. They are reconstructed from historical Ethereum state every six hours, so the RPC must support archive reads. The same page shows SDE daily history from January 2026 and month-end points.
- `/metrics` provides balance, limit, utilization, freshness, last-success time, and RPC-error metrics for external alerting.
- An optional webhook sends state-change, recovery, and hourly reminder notifications.
- A failed RPC poll preserves the last good value, records the error, and retries on the next interval.
- `/readyz` fails when there is no successful reading or it is older than 180 seconds. `/healthz` only confirms the process is alive.
- All contract and token reads in a poll are pinned to one block to prevent internally inconsistent balances.

## Operator response

For `critical` or `low`:

1. Confirm the dashboard is fresh and independently verify the pocket's USDC balance on Ethereum.
2. Check recent LitePSM swaps and expected treasury or protocol flows.
3. Notify the owner of the limit and follow the approved Sky/SoterLabs response procedure; this service never submits transactions.
4. Record the event, decision, and recovery. Confirm the monitor returns to the expected state.

For stale data or repeated RPC errors, check the Railway service and RPC provider, then fail over `ETH_RPC` if required. A history-only error does not invalidate the latest balance, but may indicate the provider does not support archive reads.

## Out of scope

This monitor does not change protocol parameters, execute transactions, infer governance intent, monitor USDC depegging, or replace an independent RPC/provider-level alert. Webhook delivery should be tested after deployment.
