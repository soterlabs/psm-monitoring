import { formatUnits } from "viem";
import type { BalanceReading, Level, StatusSnapshot } from "./types.js";

export function determineLevel(
  balance: bigint,
  limit: bigint,
  yellowPercent: number,
  orangePercent: number,
): Level {
  if (balance >= limit) return "healthy";
  const basisPoints = (balance * 10_000n) / limit;
  if (basisPoints >= BigInt(Math.round(yellowPercent * 100))) return "warning";
  if (basisPoints >= BigInt(Math.round(orangePercent * 100))) return "critical";
  return "low";
}

function decimal(raw: bigint): string {
  return formatUnits(raw, 6);
}

export function buildSnapshot(
  reading: BalanceReading,
  limit: bigint,
  yellowPercent: number,
  orangePercent: number,
): StatusSnapshot {
  const remaining = limit - reading.totalBalanceRaw;
  return {
    status: determineLevel(reading.totalBalanceRaw, limit, yellowPercent, orangePercent),
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
    yellowPercent,
    orangePercent,
  };
}
