import { Pool } from "pg";
import type { DirectExposurePoint, HistoryPoint } from "./types.js";

export interface StoredHistory {
  daily: HistoryPoint[];
  monthly: HistoryPoint[];
  generatedAt: string;
}

export interface StoredExposure {
  points: DirectExposurePoint[];
  generatedAt: string;
}

type HistoryInterval = "daily" | "monthly";

export class SnapshotStore {
  private readonly pool: Pool;
  private initialized?: Promise<void>;

  constructor(databaseUrl: string) {
    this.pool = new Pool({ connectionString: databaseUrl, max: 3 });
  }

  static fromEnvironment(): SnapshotStore | undefined {
    const databaseUrl = process.env.DATABASE_URL;
    return databaseUrl ? new SnapshotStore(databaseUrl) : undefined;
  }

  async initialize(): Promise<void> {
    this.initialized ??= this.createSchema();
    return this.initialized;
  }

  async saveHistory(points: HistoryPoint[], interval: HistoryInterval): Promise<void> {
    await this.initialize();
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      for (const point of points) {
        await client.query(
          `INSERT INTO psm_balance_snapshots
             (sample_date, interval, observed_at, block_number, balance_usdc, utilization_percent, updated_at)
           VALUES ($1::date, $2, $3::timestamptz, $4::numeric, $5::numeric, $6, now())
           ON CONFLICT (sample_date, interval) DO UPDATE SET
             observed_at = EXCLUDED.observed_at,
             block_number = EXCLUDED.block_number,
             balance_usdc = EXCLUDED.balance_usdc,
             utilization_percent = EXCLUDED.utilization_percent,
             updated_at = now()`,
          [point.timestamp.slice(0, 10), interval, point.timestamp, point.blockNumber, point.balanceUsdc, point.utilizationPercent],
        );
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async loadHistory(): Promise<StoredHistory | undefined> {
    await this.initialize();
    const result = await this.pool.query<{
      interval: HistoryInterval;
      observed_at: Date;
      block_number: string;
      balance_usdc: string;
      utilization_percent: number;
      updated_at: Date;
    }>(
      `SELECT interval, observed_at, block_number::text, balance_usdc::text,
              utilization_percent, updated_at
         FROM (
           SELECT *, row_number() OVER (PARTITION BY interval ORDER BY sample_date DESC) AS position
             FROM psm_balance_snapshots
         ) snapshots
        WHERE interval = 'monthly' OR position <= 180
        ORDER BY observed_at ASC`,
    );
    if (result.rows.length === 0) return undefined;
    const point = (row: typeof result.rows[number]): HistoryPoint => ({
      timestamp: row.observed_at.toISOString(),
      blockNumber: row.block_number,
      balanceUsdc: row.balance_usdc,
      utilizationPercent: row.utilization_percent,
    });
    const generatedAt = result.rows.reduce((latest, row) => row.updated_at > latest ? row.updated_at : latest, result.rows[0]!.updated_at).toISOString();
    return {
      daily: result.rows.filter((row) => row.interval === "daily").map(point),
      monthly: result.rows.filter((row) => row.interval === "monthly").map(point),
      generatedAt,
    };
  }

  async saveExposure(points: DirectExposurePoint[]): Promise<void> {
    await this.initialize();
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      for (const point of points) {
        await client.query(
          `INSERT INTO direct_exposure_snapshots (sample_date, total_usd, venues, updated_at)
           VALUES ($1::date, $2, $3::jsonb, now())
           ON CONFLICT (sample_date) DO UPDATE SET
             total_usd = EXCLUDED.total_usd,
             venues = EXCLUDED.venues,
             updated_at = now()`,
          [point.date, point.totalUsd, JSON.stringify(point.venues)],
        );
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async loadExposure(): Promise<StoredExposure | undefined> {
    await this.initialize();
    const result = await this.pool.query<{
      sample_date: string;
      total_usd: number;
      venues: Record<string, number>;
      updated_at: Date;
    }>(
      `SELECT to_char(sample_date, 'YYYY-MM-DD') AS sample_date,
              total_usd, venues, updated_at
         FROM direct_exposure_snapshots
        ORDER BY sample_date ASC`,
    );
    if (result.rows.length === 0) return undefined;
    const generatedAt = result.rows.reduce((latest, row) => row.updated_at > latest ? row.updated_at : latest, result.rows[0]!.updated_at).toISOString();
    return {
      points: result.rows.map((row) => ({ date: row.sample_date, totalUsd: Number(row.total_usd), venues: row.venues })),
      generatedAt,
    };
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  private async createSchema(): Promise<void> {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS psm_balance_snapshots (
        sample_date date NOT NULL,
        interval text NOT NULL CHECK (interval IN ('daily', 'monthly')),
        observed_at timestamptz NOT NULL,
        block_number numeric(78, 0) NOT NULL,
        balance_usdc numeric(30, 6) NOT NULL,
        utilization_percent double precision NOT NULL,
        updated_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (sample_date, interval)
      );
      CREATE INDEX IF NOT EXISTS psm_balance_snapshots_observed_at_idx
        ON psm_balance_snapshots (observed_at DESC);
      CREATE TABLE IF NOT EXISTS direct_exposure_snapshots (
        sample_date date PRIMARY KEY,
        total_usd double precision NOT NULL,
        venues jsonb NOT NULL,
        updated_at timestamptz NOT NULL DEFAULT now()
      );
    `);
  }
}
