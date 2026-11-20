import { buildLiquiditySnapshot } from "./status.js";
import { parseUnits } from "viem";
import type { LiquiditySnapshot } from "./status.js";
import type { WithdrawalMonitor } from "./withdrawals.js";

export interface IntradaySnapshot {
  observedAt: string;
  reserve: LiquiditySnapshot;
  backfilled?: boolean;
  supplyDate?: string;
  withdrawals?: Awaited<ReturnType<WithdrawalMonitor["result"]>>;
  depositors?: Awaited<ReturnType<WithdrawalMonitor["result"]>>;
}

export function intradayHistory(samples: IntradaySnapshot[], range: "24h" | "7d" = "24h") {
  samples = samples.map(sample => {
    const r = sample.reserve;
    if (!r.circulatingSupply) return sample;
    const reserve = buildLiquiditySnapshot({ ...r, checkedAt: sample.observedAt,
      pocketBalanceRaw: parseUnits(r.pocketBalanceUsdc ?? r.totalBalanceUsdc, 6), psmBalanceRaw: parseUnits(r.psmBalanceUsdc ?? "0", 6), totalBalanceRaw: parseUnits(r.totalBalanceUsdc, 6) }, { circulatingSupply: r.circulatingSupply, supplyCheckedAt: r.supplyCheckedAt });
    return { ...sample, reserve };
  });
  return { range, interval: "10-minute", generatedAt: samples.at(-1)?.observedAt ?? null,
    points: samples.map(({ reserve, backfilled, supplyDate }) => ({ backfilled: backfilled ?? false, supplyDate: supplyDate ?? null, timestamp: reserve.checkedAt, blockTimestamp: reserve.blockTimestamp, blockNumber: reserve.blockNumber,
      targetPercent: reserve.targetPercent, balanceUsdc: reserve.totalBalanceUsdc, targetUsdc: reserve.limitUsdc, circulatingSupply: reserve.circulatingSupply,
      utilizationPercent: reserve.utilizationPercent })),
    targetPoints: samples.map(({ reserve }) => ({ timestamp: reserve.checkedAt, targetUsdc: reserve.limitUsdc })),
  };
}
