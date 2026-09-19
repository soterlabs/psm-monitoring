import { formatUnits } from "viem";
import type { BalanceReading, Level, StatusSnapshot } from "./types.js";

export function determineLevel(
  balance: bigint,
  limit: bigint,
  warningPercent: number,
  criticalPercent: number,
): Level {
  if (balance >= limit) return "exceeded";
  const basisPoints = (balance * 10_000n) / limit;
  if (basisPoints >= BigInt(Math.round(criticalPercent * 100))) return "critical";
  if (basisPoints >= BigInt(Math.round(warningPercent * 100))) return "warning";
  return "ok";
}

function decimal(raw: bigint): string {
  return formatUnits(raw, 6);
}

export function buildSnapshot(
  reading: BalanceReading,
  limit: bigint,
  warningPercent: number,
  criticalPercent: number,
): StatusSnapshot {
  const remaining = limit - reading.totalBalanceRaw;
  return {
    status: determineLevel(reading.totalBalanceRaw, limit, warningPercent, criticalPercent),
    checkedAt: reading.checkedAt,
    blockNumber: reading.blockNumber,
    blockTimestamp: reading.blockTimestamp,
    chainId: reading.chainId,
    psmAddress: reading.psmAddress,
    pocketAddress: reading.pocketAddress,
    tokenAddress: reading.tokenAddress,
    pocketBalanceUsdc: decimal(reading.pocketBalanceRaw),
    psmBalanceUsdc: decimal(reading.psmBalanceRaw),
    totalBalanceUsdc: decimal(reading.totalBalanceRaw),
    limitUsdc: decimal(limit),
    remainingUsdc: decimal(remaining),
    utilizationPercent: Number((reading.totalBalanceRaw * 1_000_000n) / limit) / 10_000,
    warningPercent,
    criticalPercent,
  };
}
