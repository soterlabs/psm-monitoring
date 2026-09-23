import { Pool } from "pg";
import type { DirectExposurePoint, HistoryPoint } from "./types.js";
import type { SlackAlertLevel, SlackAlertState, SlackAlertStateStore } from "./slack-alerts.js";

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

export class SnapshotStore implements SlackAlertStateStore {
  private readonly pool: Pool;
  private initialized?: Promise<void>;

  constructor(databaseUrl: string) {
    this.pool = new Pool({
      connectionString: databaseUrl,
      max: 3,
      idleTimeoutMillis: 10_000,
      allowExitOnIdle: true,
    });
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

  async loadSlackAlertState(): Promise<SlackAlertState | undefined> {
    await this.initialize();
    const result = await this.pool.query<{
      level: SlackAlertLevel;
      last_checked_at: Date;
      last_balance_usdc: string;
      last_info_sent_at: Date;
    }>(`SELECT level, last_checked_at, last_balance_usdc::text, last_info_sent_at FROM slack_alert_state WHERE singleton = true`);
    const row = result.rows[0];
    if (!row) return undefined;
    return {
      level: row.level,
      lastCheckedAt: row.last_checked_at.toISOString(),
      lastBalanceUsdc: row.last_balance_usdc,
      lastInfoSentAt: row.last_info_sent_at.toISOString(),
    };
  }

  async saveSlackAlertState(state: SlackAlertState): Promise<void> {
    await this.initialize();
    await this.pool.query(
      `INSERT INTO slack_alert_state (singleton, level, last_checked_at, last_balance_usdc, last_info_sent_at)
       VALUES (true, $1, $2::timestamptz, $3::numeric, $4::timestamptz)
       ON CONFLICT (singleton) DO UPDATE SET
         level = EXCLUDED.level,
         last_checked_at = EXCLUDED.last_checked_at,
         last_balance_usdc = EXCLUDED.last_balance_usdc,
         last_info_sent_at = EXCLUDED.last_info_sent_at`,
      [state.level, state.lastCheckedAt, state.lastBalanceUsdc, state.lastInfoSentAt ?? null],
    );
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
      CREATE TABLE IF NOT EXISTS slack_alert_state (
        singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
        level text NOT NULL CONSTRAINT slack_alert_state_level_check
          CHECK (level IN ('healthy', 'below_4_0', 'below_3_9', 'below_3_8', 'below_3_7', 'below_3_6', 'below_3_5')),
        last_checked_at timestamptz NOT NULL,
        last_balance_usdc numeric(30, 6) NOT NULL,
        last_info_sent_at timestamptz NOT NULL DEFAULT now()
      );
      ALTER TABLE slack_alert_state
        ADD COLUMN IF NOT EXISTS last_info_sent_at timestamptz NOT NULL DEFAULT now();
      DO $migration$
      BEGIN
        IF EXISTS (
          SELECT 1
            FROM pg_constraint
           WHERE conrelid = 'slack_alert_state'::regclass
             AND conname = 'slack_alert_state_level_check'
             AND position('below_4_0' IN pg_get_constraintdef(oid)) = 0
        ) THEN
          ALTER TABLE slack_alert_state DROP CONSTRAINT slack_alert_state_level_check;
          UPDATE slack_alert_state
             SET level = CASE
               WHEN last_balance_usdc < 3500000000 THEN 'below_3_5'
               WHEN last_balance_usdc < 3600000000 THEN 'below_3_6'
               WHEN last_balance_usdc < 3700000000 THEN 'below_3_7'
               WHEN last_balance_usdc < 3800000000 THEN 'below_3_8'
               WHEN last_balance_usdc < 3900000000 THEN 'below_3_9'
               WHEN last_balance_usdc < 4000000000 THEN 'below_4_0'
               ELSE 'healthy'
             END;
          ALTER TABLE slack_alert_state
            ADD CONSTRAINT slack_alert_state_level_check
            CHECK (level IN ('healthy', 'below_4_0', 'below_3_9', 'below_3_8', 'below_3_7', 'below_3_6', 'below_3_5'));
        END IF;
      END;
      $migration$;
    `);
  }
}
