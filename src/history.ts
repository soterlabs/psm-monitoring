import { formatUnits, type Address } from "viem";
import type { Config } from "./config.js";
import { findBlockNearTimestamp, readUsdcAtBlock, type makeClient } from "./chain.js";
import type { HistoryPoint, HistoryRange, HistorySeries } from "./types.js";
import { safeErrorMessage } from "./errors.js";

type Client = ReturnType<typeof makeClient>;
const DAY_MS = 86_400_000;
const HISTORY_REFRESH_MS = 6 * 60 * 60 * 1_000;

export function historyTargets(range: HistoryRange, now: Date): Date[] {
  if (range === "90d") {
    return Array.from({ length: 90 }, (_, index) => new Date(now.getTime() - (89 - index) * DAY_MS));
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

  constructor(private readonly client: Client, private readonly config: Config) {}

  start(pocket: Address): void {
    void this.load(pocket);
    this.timer = setInterval(() => void this.load(pocket), HISTORY_REFRESH_MS);
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
      const latestBlock = await this.client.getBlock({ blockTag: "latest" });
      const latest = { number: latestBlock.number, timestamp: latestBlock.timestamp };
      const now = new Date(Number(latest.timestamp) * 1_000);
      const ranges: HistoryRange[] = ["90d", "monthly"];

      for (const range of ranges) {
        const points = await parallelMap(historyTargets(range, now), 1, async (target): Promise<HistoryPoint> => {
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
        this.series.set(range, {
          range,
          interval: range === "90d" ? "daily" : "monthly",
          generatedAt: new Date().toISOString(),
          limitUsdc: formatUnits(this.config.limitRaw, 6),
          points,
        });
      }
      delete this.lastError;
      console.log(JSON.stringify({ event: "history_loaded", dailyPoints: this.series.get("90d")?.points.length, monthlyPoints: this.series.get("monthly")?.points.length }));
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
}
