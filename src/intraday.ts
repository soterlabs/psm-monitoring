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
  return { range, interval: "10-minute", generatedAt: samples.at(-1)?.observedAt ?? null,
    points: samples.map(({ reserve, backfilled, supplyDate }) => ({ backfilled: backfilled ?? false, supplyDate: supplyDate ?? null, timestamp: reserve.blockTimestamp, blockNumber: reserve.blockNumber,
      balanceUsdc: reserve.totalBalanceUsdc, targetUsdc: reserve.limitUsdc, circulatingSupply: reserve.circulatingSupply,
      utilizationPercent: reserve.utilizationPercent })),
    targetPoints: samples.map(({ reserve }) => ({ timestamp: reserve.blockTimestamp, targetUsdc: reserve.limitUsdc })),
  };
}
