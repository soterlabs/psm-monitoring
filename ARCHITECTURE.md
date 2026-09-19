# Where the LitePSM balance lives

## Short version

The monitored USDC is not normally held by the LitePSM contract itself. It is held by the LitePSM's dedicated **pocket**:

| Component | Ethereum address | Role |
| --- | --- | --- |
| USDC | [`0xA0b8…6eB48`](https://etherscan.io/address/0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48) | Asset being monitored |
| Pocket | [`0x3730…D7341`](https://etherscan.io/address/0x37305B1cD40574E4C5Ce33f8e8306Be057fD7341) | Holds the large USDC balance |
| LitePSM | [`0xf6e7…53042`](https://etherscan.io/address/0xf6e72Db5454dd049d0788e411b06CfAF16853042) | Executes swaps and protocol accounting; holds the prefunded DAI side |
| USDS PSM Wrapper | [`0xA188…0f98c`](https://etherscan.io/address/0xA188EEC8F81263234dA3622A406892F3D630f98c) | Adds a USDC↔USDS interface around the DAI-based LitePSM |
| USDS | [`0xdC03…384F`](https://etherscan.io/address/0xdC035D45d973E3EC169d2276DDab16f1e407384F) | Sky's newer stablecoin token |

This monitor therefore calculates:

```text
USDC.balanceOf(LitePSM.pocket()) + USDC.balanceOf(LitePSM)
```

The second term is normally zero, but including it prevents a transient or future direct PSM balance from being missed.

## Why there is a pocket

LitePSM separates execution from USDC custody. Its immutable `pocket()` identifies the address where the USDC reserve is kept. The current pocket has no deployed bytecode and has granted the LitePSM a near-unlimited USDC allowance, allowing LitePSM swaps to move USDC into or out of the pocket.

That is why looking only at the LitePSM address on an explorer is misleading: the LitePSM generally shows DAI, while the multi-billion USDC reserve appears at the pocket address. This separation is an intentional part of the [LitePSM design](https://github.com/sky-ecosystem/dss-lite-psm).

## Swap paths

The underlying LitePSM is DAI-based:

```text
USDC → pocket   | LitePSM releases DAI to the user
DAI  → LitePSM  | LitePSM moves USDC from pocket to the user
```

The [USDS PSM Wrapper](https://github.com/sky-ecosystem/usds-wrappers) exposes the same liquidity as USDC↔USDS:

```text
USDC → wrapper → LitePSM → DAI accounting → UsdsJoin → USDS
USDS → wrapper → UsdsJoin → DAI accounting → LitePSM → USDC
```

It points to this exact LitePSM and reports the same pocket. Internally it uses the legacy [`DaiJoin`](https://etherscan.io/address/0x9759A6Ac90977b93B58547b4A71c78317f391A28) and [`UsdsJoin`](https://etherscan.io/address/0x3C0f895007CA717Aa01c8693e59DF1e8C3777FEB) adapters to move between DAI and USDS accounting. The wrapper is a routing contract, not the long-term custodian of the USDC reserve.

## USDS wrapper versus the DAI–USDS converter

These are related but distinct contracts:

- **USDS PSM Wrapper** (`0xA188…0f98c`) provides USDC↔USDS swaps by composing LitePSM with the join adapters.
- **DaiUsds converter** ([`0x3225…276A`](https://etherscan.io/address/0x3225737a9Bbb6473CB4a45b7244ACa2BeFdB276A)) is a separate permissionless convenience contract for direct DAI↔USDS conversion at 1:1.

The USDS PSM Wrapper does not route through the DaiUsds converter; it performs the equivalent accounting transition directly through `DaiJoin` and `UsdsJoin`.

## What the dashboard means

The displayed balance measures USDC reserve liquidity associated with this LitePSM. It does **not** represent the wrapper's token balance, total USDS supply, the LitePSM's DAI buffer, or Sky's on-chain debt ceiling. The configured 4B value is the monitor's minimum healthy target.
