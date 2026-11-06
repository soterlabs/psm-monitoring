import { formatUnits, parseUnits } from "viem";
import { reserveTargetRaw, supplyRaw } from "./supply.js";
import type { SnapshotStore } from "./database.js";
import type { HistorySeries } from "./types.js";
import { safeErrorMessage } from "./errors.js";

export const TARGET_POLICY_START = "2026-11-04";
export interface DailyTarget {
  date: string;
  circulatingSupply: string;
  targetUsdc: string;
  checkedAt: string;
  source: string;
  provisional: boolean;
}

// Historical dates come from the provider's dated series, never from today's supply.
export async function readDailyTargets(request: typeof fetch = fetch, now = new Date()): Promise<DailyTarget[]> {
  const base = (process.env.SKY_DATA_API_URL ?? "https://sky.data.blockanalitica.com/internal").replace(/\/$/, "");
  const response = await request(`${base}/supply/historic/`, { cache: "no-store", signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error(`Sky daily supply request failed (${response.status})`);
  const body = await response.json() as { data?: unknown };
  if (!Array.isArray(body.data)) throw new Error("Sky daily supply history is missing");
  const today = now.toISOString().slice(0, 10), seen = new Set<string>();
  return body.data.flatMap((row: Record<string, unknown>) => {
    const date = row.date;
    if (typeof date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(date) || new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) !== date) throw new Error("Invalid daily supply date");
    if (date < TARGET_POLICY_START || date > today) return [];
    if (seen.has(date)) throw new Error("Duplicate daily supply date");
    seen.add(date);
    const total = row.total_circulating, usds = row.circulating_usds, dai = row.circulating_dai;
    if (typeof total !== "string" || typeof usds !== "string" || typeof dai !== "string") throw new Error("Daily circulating supply components are missing");
    const difference = supplyRaw(total) - supplyRaw(usds, false) - supplyRaw(dai, false);
    if (difference > 10n ** 12n || difference < -(10n ** 12n)) throw new Error("Daily circulating supply components do not reconcile");
    return [{ date, circulatingSupply: total, targetUsdc: formatUnits(reserveTargetRaw(total), 6), checkedAt: now.toISOString(), source: `${base}/supply/historic/`, provisional: date === today }];
  });
}

export function applyDailyTargets(series: HistorySeries, targets: DailyTarget[]) {
  const byDate = new Map(targets.map(target => [target.date, target]));
  const { limitUsdc: _legacyLimit, ...base } = series;
  const targetAt = (date: string) => date < TARGET_POLICY_START ? "4000000000" : byDate.get(date)?.targetUsdc ?? null;
  // Independent daily target curve keeps the Nov 4 transition accurate even
  // when reserve balances are sampled monthly or at a non-midnight UTC time.
  const targetPoints: { timestamp: string; targetUsdc: string | null }[] = [];
  const first = series.points[0]?.timestamp, last = series.points.at(-1)?.timestamp;
  if (first && last) {
    for (let time = Date.parse(`${first.slice(0, 10)}T00:00:00Z`); time <= Date.parse(last); time += 86_400_000) {
      const date = new Date(time).toISOString();
      targetPoints.push({ timestamp: time < Date.parse(first) ? first : date, targetUsdc: targetAt(date.slice(0, 10)) });
    }
    if (Date.parse(targetPoints.at(-1)!.timestamp) !== Date.parse(last)) targetPoints.push({ timestamp: last, targetUsdc: targetAt(last.slice(0, 10)) });
  }
  return { ...base, targetBasis: "daily_circulating_supply", policyStart: TARGET_POLICY_START,
    targetPoints,
    points: series.points.map(point => {
      const date = point.timestamp.slice(0, 10), legacy = date < TARGET_POLICY_START;
      const daily = byDate.get(date);
      const targetUsdc = legacy ? "4000000000" : daily?.targetUsdc ?? null;
      return { ...point, targetUsdc, circulatingSupply: legacy ? null : daily?.circulatingSupply ?? null,
        targetProvisional: !legacy && (daily?.provisional ?? false),
        targetSource: legacy ? "fixed_4b" : daily?.source ?? null,
        targetCheckedAt: legacy ? null : daily?.checkedAt ?? null,
        utilizationPercent: targetUsdc ? Number(parseUnits(point.balanceUsdc, 6) * 1_000_000n / parseUnits(targetUsdc, 6)) / 10_000 : null };
    }) };
}

export class TargetHistory {
  targets: DailyTarget[] = [];
  lastError?: { message: string; at: string };
  private refreshedAt = 0;
  private pending: Promise<void> | undefined;
  constructor(private readonly store?: SnapshotStore, private readonly read = readDailyTargets) {}

  async refresh(): Promise<void> {
    if (Date.now() - this.refreshedAt < 15 * 60_000) return;
    this.pending ??= this.load().finally(() => { this.pending = undefined; });
    await this.pending;
  }

  private async load(): Promise<void> {
    try {
      if (this.store) this.targets = await this.store.loadDailyTargets();
      const fresh = await this.read();
      if (this.store) {
        await this.store.saveDailyTargets(fresh);
        this.targets = await this.store.loadDailyTargets();
      } else this.targets = fresh;
      delete this.lastError;
      this.refreshedAt = Date.now();
    } catch (error) {
      this.lastError = { message: safeErrorMessage(error), at: new Date().toISOString() };
      // Retain saved history on upstream failure; retry without hammering the provider.
      this.refreshedAt = Date.now() - 14 * 60_000;
    }
  }
}
