import { parseUnits } from "viem";

export interface CirculatingSupply {
  circulatingSupply: string;
  supplyCheckedAt: string;
}

export const RESERVE_TARGET_PERCENT = 25;
export const TARGET_25_START = "2026-11-20";
export function targetPercentAt(timestamp: string): 25 | 30 { return timestamp.slice(0, 10) >= TARGET_25_START ? 25 : 30; }
export type ReserveBand = "healthy" | "below_30" | "below_28" | "below_25" | "below_24" | "below_22" | "below_20" | "below_18";

export function reserveTargetRaw(circulatingSupply: string, percent: number = RESERVE_TARGET_PERCENT): bigint {
  const denominator = 100n * 10n ** 12n;
  // Round the target up to a whole micro-USDC, preserving the exact percentage floor.
  return (supplyRaw(circulatingSupply) * BigInt(percent) + denominator - 1n) / denominator;
}

export function reserveRatioPercent(balanceUsdc: string, circulatingSupply: string): number {
  return Number(parseUnits(balanceUsdc, 6) * 10n ** 12n * 100_000_000n / supplyRaw(circulatingSupply)) / 1_000_000;
}

export function reserveBand(balanceUsdc: string, circulatingSupply: string, percent: 25 | 30 = RESERVE_TARGET_PERCENT): ReserveBand {
  const balance = parseUnits(balanceUsdc, 6) * 10n ** 12n;
  const supply = supplyRaw(circulatingSupply);
  if (balance < 0n) throw new Error("PSM balance must not be negative");
  for (const threshold of (percent === 25 ? [18, 20, 22, 24, 25] as const : [20, 25, 28, 30] as const)) {
    if (balance * 100n < supply * BigInt(threshold)) return `below_${threshold}`;
  }
  return "healthy";
}

export function supplyRaw(value: string, positive = true): bigint {
  if (!/^\d+(\.\d{1,18})?$/.test(value)) throw new Error("Circulating supply must be a positive decimal with at most 18 decimals");
  const raw = parseUnits(value, 18);
  if (positive && raw <= 0n) throw new Error("Circulating supply must be positive");
  return raw;
}

export async function readCirculatingSupply(request: typeof fetch = fetch): Promise<CirculatingSupply> {
  const base = process.env.SKY_DATA_API_URL ?? "https://sky.data.blockanalitica.com/internal";
  const response = await request(`${base.replace(/\/$/, "")}/supply/`, { cache: "no-store", signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error(`Sky circulating supply request failed (${response.status})`);
  const body = await response.json() as { success?: boolean; data?: { total_circulating?: unknown; circulating_usds?: unknown; circulating_dai?: unknown } };
  const total = body.data?.total_circulating, usds = body.data?.circulating_usds, dai = body.data?.circulating_dai;
  if (body.success !== true || typeof total !== "string" || typeof usds !== "string" || typeof dai !== "string") {
    throw new Error("Sky supply response is missing circulating USDS and DAI");
  }
  const difference = supplyRaw(total) - supplyRaw(usds, false) - supplyRaw(dai, false);
  if (difference > 1_000_000_000_000n || difference < -1_000_000_000_000n) throw new Error("Sky circulating supply components do not reconcile");
  return { circulatingSupply: total, supplyCheckedAt: new Date().toISOString() };
}
