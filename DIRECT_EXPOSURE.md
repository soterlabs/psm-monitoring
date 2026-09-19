# Available USDC as Sky Direct Exposure

This dashboard estimates the value of Sky Direct Exposure (SDE) that Sky could redeem, swap, or transfer into USDC to refill the Ethereum LitePSM. It is a capacity view, not a claim that the full amount is immediately withdrawable as USDC.

## Included exposure

The venue scope follows `config/sky_direct_exposures.yaml` in the private `soterlabs/settlement-cycle` repository:

| Prime | Venue | Asset represented | Route to PSM liquidity |
| --- | --- | --- | --- |
| Grove | E9 · JTRSY | Tokenized Treasury fund value | Redeem to USDC |
| Grove | E10 · BUIDL-I | Tokenized Treasury fund value | Redeem to USDC |
| Spark | S21 · USTB | Tokenized Treasury fund value | Redeem to USDC |
| Spark | S24 · sUSDS/USDT Curve reserve | USDT leg only | Withdraw and swap to USDC |
| Spark | S62 · USDT/USDS Uniswap V4 reserve | USDT leg only | Withdraw and swap to USDC |
| Spark | non-Ethereum PSM3 on Base, Arbitrum, Optimism, and Unichain | USDC leg only | Transfer or bridge USDC |

Grove E8 (JAAA), capped at $325 million, appears only in the January–March 2026 history because it was a historical SDE. Spark S61 (PYUSD/USDS) is deliberately excluded because PYUSD is not in the canonical Uniswap SDE scope.

## Calculation and history

For each date, the app sums the canonical fixed/capped venue values and derives each Prime's PSM3 USDC value as:

```text
PSM3 USDC = settlement sde_av − all named SDE venue values
total capacity = canonical named venues + Spark PSM3 USDC
```

The 90-day view uses daily values. The longer view uses month-end values beginning in January 2026. A compact baseline through August 2026 is generated from canonical monthly settlement artifacts; the current and recent month-to-date values refresh every six hours from the public settlement API. Grove has an SDE pattern entry but no configured PSM3 position, so there is no empty Grove PSM3 row in the dashboard. Values are provisional USD estimates and may be restated by the settlement process.

The app separately verifies the current PSM3 number every five minutes by reading USDC `balanceOf(PSM3)`, Spark ALM `shares()`, and PSM3 `totalShares()` on all four L2s. This makes the current chain composition independently auditable without mixing newer on-chain readings into the older settlement-dated historical series.

## Interpretation

“USDC-equivalent” is intentional. PSM3 USDC is closest to transferable USDC, but cross-chain execution still takes time. Treasury-fund values depend on redemption timing and settlement. USDT liquidity depends on pool withdrawal, swap depth, price, fees, and execution limits. The chart therefore describes potential refill capacity, not guaranteed same-block USDC liquidity.
