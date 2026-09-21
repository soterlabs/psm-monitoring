import { safeErrorMessage } from "./errors.js";
import { sdeBaselinePoints } from "./sde-baseline.js";
import type {
  DirectExposurePoint,
  DirectExposureRange,
  DirectExposureSeries,
  DirectExposureVenue,
} from "./types.js";
import type { SnapshotStore } from "./database.js";

const API_BASE = process.env.SETTLEMENT_API_URL ?? "https://settle-api-production.up.railway.app";
const SKY_DATA_API_BASE = process.env.SKY_DATA_API_URL ?? "https://sky.data.blockanalitica.com/internal";
const BASIN_JTRSY_ADDRESS = "0xf08943f817e1f902debc884c7b19ea5764594ac9";
const GROVE_ALM_ADDRESS = "0x0dcd9298e163dfd3c0b5b00f0d9093c36e40a153";
const JTRSY_VENUE_ID = "grove:E9";
const REFRESH_MS = 6 * 60 * 60 * 1_000;
const STORED_REFRESH_MS = 15 * 60 * 1_000;
const DAY_MS = 86_400_000;
const ACTIVE_OR_HISTORICAL_VENUE_IDS = new Set(["grove:E8", "grove:E9", "grove:E10", "spark:S21", "spark:S24", "spark:S62"]);

export const directExposureVenues: DirectExposureVenue[] = [
  { id: "grove:E8", prime: "Grove", label: "JAAA (historical, capped)", assetKind: "treasury", conversion: "Fund redemption to USDC" },
  { id: "grove:E9", prime: "Grove", label: "JTRSY", assetKind: "treasury", conversion: "Fund redemption to USDC" },
  { id: "grove:E10", prime: "Grove", label: "BUIDL-I", assetKind: "treasury", conversion: "Fund redemption to USDC" },
  { id: "spark:S21", prime: "Spark", label: "USTB", assetKind: "treasury", conversion: "Fund redemption to USDC" },
  { id: "spark:S24", prime: "Spark", label: "Curve USDT reserve", assetKind: "usdt", conversion: "Swap USDT to USDC" },
  { id: "spark:S62", prime: "Spark", label: "Uniswap V4 USDT reserve", assetKind: "usdt", conversion: "Swap USDT to USDC" },
  { id: "spark:psm3", prime: "Spark", label: "PSM3 USDC (four L2s)", assetKind: "usdc", conversion: "Transfer or bridge USDC" },
];

type JsonObject = Record<string, unknown>;

function object(value: unknown): JsonObject | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : undefined;
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function finite(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error("Settlement API returned a non-numeric SDE value");
  return parsed;
}

/** Extracts one Prime's daily venue values from a canonical settlement result. */
export function parsePrimeResult(prime: "grove" | "spark", input: unknown): Map<string, Record<string, number>> {
  const result = object(input);
  if (!result) throw new Error(`Settlement API returned no ${prime} result`);
  const namedByDate = new Map<string, Record<string, number>>();
  const allNamedTotals = new Map<string, number>();

  for (const rawVenue of array(result.sde_daily_breakdown)) {
    const venue = object(rawVenue);
    if (!venue || typeof venue.venue_id !== "string") continue;
    const id = `${prime}:${venue.venue_id}`;
    for (const rawDay of array(venue.daily)) {
      const day = object(rawDay);
      if (!day || typeof day.block_date !== "string") continue;
      const value = finite(day.cum_value);
      allNamedTotals.set(day.block_date, (allNamedTotals.get(day.block_date) ?? 0) + value);
      if (!ACTIVE_OR_HISTORICAL_VENUE_IDS.has(id)) continue;
      const values = namedByDate.get(day.block_date) ?? {};
      values[id] = value;
      namedByDate.set(day.block_date, values);
    }
  }

  for (const rawDay of array(result.sky_revenue_daily)) {
    const day = object(rawDay);
    if (!day || typeof day.date !== "string") continue;
    const values = namedByDate.get(day.date) ?? {};
    const namedTotal = allNamedTotals.get(day.date) ?? 0;
    const residual = finite(day.sde_av) - namedTotal;
    values[`${prime}:psm3`] = Math.max(0, Math.abs(residual) < 0.01 ? 0 : residual);
    namedByDate.set(day.date, values);
  }
  return namedByDate;
}

function mergePrimeDays(
  grove: Map<string, Record<string, number>>,
  spark: Map<string, Record<string, number>>,
): DirectExposurePoint[] {
  const sharedDates = [...grove.keys()].filter((date) => spark.has(date)).sort();
  return sharedDates.map((date) => {
    const venues = { ...grove.get(date), ...spark.get(date) };
    return { date, venues, totalUsd: Object.values(venues).reduce((sum, value) => sum + value, 0) };
  });
}

function resultFromRecord(value: unknown): unknown {
  const record = object(value);
  return record?.result;
}

async function fetchJson(path: string): Promise<unknown> {
  const response = await fetch(`${API_BASE}${path}`, {
    headers: { accept: "application/json", "user-agent": "soterlabs-psm-monitor/1.0" },
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error(`Settlement API request failed (${response.status})`);
  return response.json();
}

async function fetchSkyDataJson(path: string): Promise<unknown> {
  const response = await fetch(`${SKY_DATA_API_BASE}${path}`, {
    headers: { accept: "application/json", "user-agent": "soterlabs-psm-monitor/1.0" },
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error(`BA Labs Sky Data API request failed (${response.status})`);
  return response.json();
}

async function loadPrimeResults(prime: "grove" | "spark", now: Date): Promise<unknown[]> {
  const end = new Date(now.getTime() - DAY_MS);
  const start = new Date(end.getTime() - 89 * DAY_MS);
  const date = (value: Date): string => value.toISOString().slice(0, 10);
  const [latestRaw, historyRaw] = await Promise.all([
    fetchJson(`/v1/revenue/${prime}/latest`),
    fetchJson(`/v1/revenue/${prime}/history?start=${date(start)}&end=${date(end)}&limit=90`),
  ]);
  const latest = object(latestRaw);
  const latestData = object(latest?.data);
  const history = object(historyRaw);
  return [latestData?.result, ...array(history?.results).map(resultFromRecord)].filter(Boolean);
}

function combineDocuments(prime: "grove" | "spark", documents: unknown[]): Map<string, Record<string, number>> {
  const combined = new Map<string, Record<string, number>>();
  // History is newest-first and latest is first: retain the first published value for a date.
  for (const document of documents) {
    for (const [date, values] of parsePrimeResult(prime, document)) {
      if (!combined.has(date)) combined.set(date, values);
    }
  }
  return combined;
}

function monthEnd(points: DirectExposurePoint[]): DirectExposurePoint[] {
  const months = new Map<string, DirectExposurePoint>();
  for (const point of points) months.set(point.date.slice(0, 7), point);
  return [...months.values()].sort((a, b) => a.date.localeCompare(b.date));
}

/** Extracts the USD asset value of Grove's Basin JTRSY allocation by date. */
export function parseBasinJtrsyHistory(input: unknown): Map<string, number> {
  const response = object(input);
  const values = new Map<string, number>();
  for (const rawDay of array(response?.data)) {
    const day = object(rawDay);
    if (!day || typeof day.date !== "string") continue;
    const assets = finite(day.assets);
    if (assets < 0) throw new Error("BA Labs Sky Data API returned a negative Basin JTRSY value");
    values.set(day.date, assets);
  }
  if (values.size === 0) throw new Error("BA Labs Sky Data API returned no Basin JTRSY history");
  return values;
}

/** Adds the separate Basin holding into the existing Grove JTRSY chart line and total. */
export function addBasinJtrsy(
  points: DirectExposurePoint[],
  basinByDate: Map<string, number>,
): DirectExposurePoint[] {
  return points.map((point) => {
    const basin = basinByDate.get(point.date);
    if (basin === undefined) return point;
    return {
      ...point,
      totalUsd: point.totalUsd + basin,
      venues: {
        ...point.venues,
        [JTRSY_VENUE_ID]: (point.venues[JTRSY_VENUE_ID] ?? 0) + basin,
      },
    };
  });
}

async function loadBasinJtrsyHistory(now: Date): Promise<Map<string, number>> {
  const start = Date.UTC(2026, 0, 1);
  const daysAgo = Math.max(90, Math.ceil((now.getTime() - start) / DAY_MS) + 7);
  const query = new URLSearchParams({
    wallet_address: GROVE_ALM_ADDRESS,
    network: "ethereum",
    days_ago: String(daysAgo),
  });
  const response = await fetchSkyDataJson(
    `/allocations/${BASIN_JTRSY_ADDRESS}/historic/?${query.toString()}`,
  );
  return parseBasinJtrsyHistory(response);
}

export async function loadDirectExposurePoints(now = new Date()): Promise<DirectExposurePoint[]> {
  const [groveDocs, sparkDocs, basinByDate] = await Promise.all([
    loadPrimeResults("grove", now),
    loadPrimeResults("spark", now),
    loadBasinJtrsyHistory(now),
  ]);
  const live = mergePrimeDays(combineDocuments("grove", groveDocs), combineDocuments("spark", sparkDocs));
  const byDate = new Map<string, DirectExposurePoint>(sdeBaselinePoints.map((point) => [point.date, point]));
  for (const point of live) byDate.set(point.date, point);
  const canonical = [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
  return addBasinJtrsy(canonical, basinByDate);
}

export class DirectExposureMonitor {
  readonly series = new Map<DirectExposureRange, DirectExposureSeries>();
  loading = false;
  lastError?: { message: string; at: string };
  private timer?: NodeJS.Timeout;
  private retryTimer?: NodeJS.Timeout;

  constructor(private readonly store?: SnapshotStore) {}

  start(): void {
    void this.load();
    this.timer = setInterval(() => void this.load(), this.store ? STORED_REFRESH_MS : REFRESH_MS);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.retryTimer) clearTimeout(this.retryTimer);
  }

  async load(now = new Date()): Promise<void> {
    if (this.loading) return;
    this.loading = true;
    try {
      if (this.store) {
        try {
          const stored = await this.store.loadExposure();
          if (stored?.points.length) {
            this.setSeries(stored.points, stored.generatedAt);
            delete this.lastError;
            console.log(JSON.stringify({ event: "direct_exposure_loaded_from_database", asOf: stored.points.at(-1)?.date, points: stored.points.length }));
            return;
          }
        } catch (error) {
          console.error(JSON.stringify({ event: "direct_exposure_database_read_failed", message: safeErrorMessage(error) }));
        }
      }
      const all = await loadDirectExposurePoints(now);
      this.setSeries(all, new Date().toISOString());
      if (this.store) {
        try {
          await this.store.saveExposure(all);
        } catch (error) {
          console.error(JSON.stringify({ event: "direct_exposure_database_seed_failed", message: safeErrorMessage(error) }));
        }
      }
      delete this.lastError;
    } catch (error) {
      const message = safeErrorMessage(error);
      this.lastError = { message, at: new Date().toISOString() };
      console.error(JSON.stringify({ event: "direct_exposure_failed", message, at: this.lastError.at }));
      this.retryTimer = setTimeout(() => void this.load(), 30_000);
      this.retryTimer.unref();
    } finally {
      this.loading = false;
    }
  }

  private setSeries(all: DirectExposurePoint[], generatedAt: string): void {
    const asOf = all.at(-1)?.date;
    if (!asOf) throw new Error("No shared Grove and Spark SDE dates are available");
    const cutoff = new Date(`${asOf}T00:00:00Z`).getTime() - 89 * DAY_MS;
    const daily = all.filter((point) => new Date(`${point.date}T00:00:00Z`).getTime() >= cutoff);
    const monthly = monthEnd(all.filter((point) => point.date >= "2026-01-01"));
    const base = { generatedAt, asOf, provisional: true, unit: "USD (USDC-equivalent)" as const, venues: directExposureVenues };
    this.series.set("90d", { ...base, range: "90d", interval: "daily", points: daily });
    this.series.set("30d", { ...base, range: "30d", interval: "daily", points: daily.slice(-30) });
    this.series.set("7d", { ...base, range: "7d", interval: "daily", points: daily.slice(-7) });
    this.series.set("ytd", { ...base, range: "ytd", interval: "daily", points: all.filter((point) => point.date >= "2026-01-01") });
    this.series.set("monthly", { ...base, range: "monthly", interval: "monthly", points: monthly });
    console.log(JSON.stringify({ event: "direct_exposure_loaded", asOf, dailyPoints: daily.length, ytdPoints: this.series.get("ytd")?.points.length, monthlyPoints: monthly.length }));
  }
}
