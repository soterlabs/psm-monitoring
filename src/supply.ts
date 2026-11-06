import { parseUnits } from "viem";

export interface CirculatingSupply {
  circulatingSupply: string;
  supplyCheckedAt: string;
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
