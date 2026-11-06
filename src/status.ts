import { formatUnits } from "viem";
import type { BalanceReading, Level, StatusSnapshot } from "./types.js";
import { reserveTargetRaw, reserveBand, reserveRatioPercent, RESERVE_TARGET_PERCENT, type CirculatingSupply, type ReserveBand } from "./supply.js";

export interface LiquiditySnapshot extends StatusSnapshot, CirculatingSupply {
  targetPercent: number;
  reserveRatioPercent: number;
  reserveBand: ReserveBand;
}

export function buildLiquiditySnapshot(reading: BalanceReading, supply: CirculatingSupply): LiquiditySnapshot {
  const band = reserveBand(formatUnits(reading.totalBalanceRaw, 6), supply.circulatingSupply);
  const status: Level = band === "healthy" ? "healthy" : band === "below_30" ? "warning" : band === "below_28" ? "critical" : "low";
  const base = buildSnapshot(reading, reserveTargetRaw(supply.circulatingSupply), 28 / 30 * 100, 25 / 30 * 100);
  return { ...base, ...supply, status, reserveBand: band, targetPercent: RESERVE_TARGET_PERCENT,
    reserveRatioPercent: reserveRatioPercent(base.totalBalanceUsdc, supply.circulatingSupply) };
}

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
