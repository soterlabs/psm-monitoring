import { formatUnits, type Address } from "viem";
import type { Config } from "./config.js";
import { findBlockNearTimestamp, readUsdcAtBlock, type makeClient } from "./chain.js";
import type { HistoryPoint, HistoryRange, HistorySeries } from "./types.js";
import { safeErrorMessage } from "./errors.js";
import type { SnapshotStore, StoredHistory } from "./database.js";

type Client = ReturnType<typeof makeClient>;
const DAY_MS = 86_400_000;
const HISTORY_REFRESH_MS = 6 * 60 * 60 * 1_000;
const STORED_HISTORY_REFRESH_MS = 15 * 60 * 1_000;

export function historyTargets(range: HistoryRange, now: Date): Date[] {
  if (range !== "monthly") {
    const length = { "7d": 7, "30d": 30, "90d": 90, "180d": 180 }[range];
    return Array.from({ length }, (_, index) => new Date(now.getTime() - (length - 1 - index) * DAY_MS));
  }

  const targets: Date[] = [];
  let year = 2025;
  let month = 0;
  while (year < now.getUTCFullYear() || (year === now.getUTCFullYear() && month <= now.getUTCMonth())) {
    targets.push(new Date(Date.UTC(year, month, 1)));
    month += 1;
    if (month === 12) {
      month = 0;
      year += 1;
    }
  }
  if (targets.at(-1)?.getTime() !== now.getTime()) targets.push(now);
  return targets;
}

async function parallelMap<T, R>(items: T[], concurrency: number, operation: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  async function worker(): Promise<void> {
    while (next < items.length) {
      const index = next;
      next += 1;
      const item = items[index];
      if (item !== undefined) results[index] = await operation(item);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => worker()));
  return results;
}

export class HistoryMonitor {
  readonly series = new Map<HistoryRange, HistorySeries>();
  loading = false;
  lastError?: { message: string; at: string };
  private timer?: NodeJS.Timeout;
  private retryTimer?: NodeJS.Timeout;

  constructor(private readonly client: Client, private readonly config: Config, private readonly store?: SnapshotStore) {}

  start(pocket: Address): void {
    void this.load(pocket);
    this.timer = setInterval(() => void this.load(pocket), this.store ? STORED_HISTORY_REFRESH_MS : HISTORY_REFRESH_MS);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.retryTimer) clearTimeout(this.retryTimer);
  }

  async load(pocket: Address): Promise<void> {
    if (this.loading) return;
    this.loading = true;
    try {
      if (this.store) {
        try {
          const stored = await this.store.loadHistory();
          if (stored?.daily.length) {
            this.setStoredSeries(stored);
            delete this.lastError;
            console.log(JSON.stringify({ event: "history_loaded_from_database", dailyPoints: stored.daily.length, monthlyPoints: stored.monthly.length }));
            return;
          }
        } catch (error) {
          console.error(JSON.stringify({ event: "history_database_read_failed", message: safeErrorMessage(error) }));
        }
      }
      const latestBlock = await this.client.getBlock({ blockTag: "latest" });
      const latest = { number: latestBlock.number, timestamp: latestBlock.timestamp };
      const now = new Date(Number(latest.timestamp) * 1_000);
      const dailyPoints = await parallelMap(historyTargets("180d", now), 1, async (target): Promise<HistoryPoint> => {
          const block = await findBlockNearTimestamp(this.client, BigInt(Math.floor(target.getTime() / 1_000)), latest);
          const balance = await readUsdcAtBlock(this.client, this.config, pocket, block.number);
          await new Promise((resolve) => setTimeout(resolve, 100));
          return {
            timestamp: new Date(Number(block.timestamp) * 1_000).toISOString(),
            blockNumber: block.number.toString(),
            balanceUsdc: formatUnits(balance, 6),
            utilizationPercent: Number((balance * 1_000_000n) / this.config.limitRaw) / 10_000,
          };
      });
      const monthlyPoints = await parallelMap(historyTargets("monthly", now), 1, async (target): Promise<HistoryPoint> => {
        const block = await findBlockNearTimestamp(this.client, BigInt(Math.floor(target.getTime() / 1_000)), latest);
        const balance = await readUsdcAtBlock(this.client, this.config, pocket, block.number);
        await new Promise((resolve) => setTimeout(resolve, 100));
        return {
          timestamp: new Date(Number(block.timestamp) * 1_000).toISOString(),
          blockNumber: block.number.toString(),
          balanceUsdc: formatUnits(balance, 6),
          utilizationPercent: Number((balance * 1_000_000n) / this.config.limitRaw) / 10_000,
        };
      });
      const generatedAt = new Date().toISOString();
      this.setSeries(dailyPoints, monthlyPoints, generatedAt);
      if (this.store) {
        try {
          await this.store.saveHistory(dailyPoints, "daily");
          await this.store.saveHistory(monthlyPoints.slice(0, -1), "monthly");
        } catch (error) {
          console.error(JSON.stringify({ event: "history_database_seed_failed", message: safeErrorMessage(error) }));
        }
      }
      delete this.lastError;
      console.log(JSON.stringify({ event: "history_loaded", dailyPoints: dailyPoints.length, monthlyPoints: monthlyPoints.length }));
    } catch (error) {
      const message = safeErrorMessage(error);
      this.lastError = { message, at: new Date().toISOString() };
      console.error(JSON.stringify({ event: "history_failed", message, at: this.lastError.at }));
      this.retryTimer = setTimeout(() => void this.load(pocket), 30_000);
      this.retryTimer.unref();
    } finally {
      this.loading = false;
    }
  }

  private setStoredSeries(stored: StoredHistory): void {
    const monthly = [...stored.monthly];
    const latest = stored.daily.at(-1);
    if (latest && monthly.at(-1)?.timestamp !== latest.timestamp) monthly.push(latest);
    this.setSeries(stored.daily.slice(-180), monthly, stored.generatedAt);
  }

  private setSeries(dailyPoints: HistoryPoint[], monthlyPoints: HistoryPoint[], generatedAt: string): void {
    const base = { generatedAt, limitUsdc: formatUnits(this.config.limitRaw, 6) };
    this.series.set("180d", { ...base, range: "180d", interval: "daily", points: dailyPoints });
    this.series.set("90d", { ...base, range: "90d", interval: "daily", points: dailyPoints.slice(-90) });
    this.series.set("30d", { ...base, range: "30d", interval: "daily", points: dailyPoints.slice(-30) });
    this.series.set("7d", { ...base, range: "7d", interval: "daily", points: dailyPoints.slice(-7) });
    this.series.set("monthly", { ...base, range: "monthly", interval: "monthly", points: monthlyPoints });
  }
}
