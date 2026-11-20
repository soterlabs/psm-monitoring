import { Pool } from "pg";
import type { IntradaySnapshot } from "./intraday.js";
import type { DailyTarget } from "./target-history.js";
import type { AddressLabelStore, CachedLabel } from "./address-labels.js";
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

export class SnapshotStore implements SlackAlertStateStore, AddressLabelStore {
  private readonly pool: Pool;
  private initialized: Promise<void> | undefined;

  constructor(databaseUrl: string) {
    this.pool = new Pool({
      connectionString: databaseUrl,
      max: 3,
      connectionTimeoutMillis: 5_000,
      statement_timeout: 15_000,
      idleTimeoutMillis: 10_000,
      allowExitOnIdle: true,
    });
  }

  static fromEnvironment(): SnapshotStore | undefined {
    const databaseUrl = process.env.DATABASE_URL;
    return databaseUrl ? new SnapshotStore(databaseUrl) : undefined;
  }

  async initialize(): Promise<void> {
    this.initialized ??= this.createSchema().catch(error => { this.initialized = undefined; throw error; });
    return this.initialized;
  }

  async saveIntraday(sample: IntradaySnapshot): Promise<void> {
    await this.initialize();
    const bucket = new Date(Math.floor(Date.parse(sample.observedAt) / 600_000) * 600_000).toISOString();
    await this.pool.query(`INSERT INTO psm_intraday_snapshots (bucket, observed_at, payload) VALUES ($1, $2, $3::jsonb)
      ON CONFLICT (bucket) DO UPDATE SET observed_at = EXCLUDED.observed_at, payload = EXCLUDED.payload
      WHERE EXCLUDED.observed_at > psm_intraday_snapshots.observed_at`, [bucket, sample.observedAt, JSON.stringify(sample)]);
  }

  async loadIntraday(now = new Date(), days: 1 | 7 = 1): Promise<IntradaySnapshot[]> {
    await this.initialize();
    const result = await this.pool.query<{ payload: IntradaySnapshot }>(
      `SELECT payload FROM psm_intraday_snapshots WHERE observed_at >= $1::timestamptz - ($2::integer * interval '1 day')
        AND observed_at <= $1::timestamptz ORDER BY observed_at`, [now.toISOString(), days]);
    return result.rows.map(row => row.payload);
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

  async loadAddressLabels(provider: string): Promise<{ address: string; value: CachedLabel }[]> {
    await this.initialize();
    const result = await this.pool.query<{ address: string; label: string | null; source: string | null; expires_at: Date }>(
      "SELECT address, label, source, expires_at FROM psm_address_labels WHERE provider = $1 AND (expires_at > now() OR label IS NOT NULL)", [provider]);
    return result.rows.map(row => ({ address: row.address, value: { label: row.label, source: row.source, expiresAt: row.expires_at.getTime() } }));
  }

  async saveAddressLabel(provider: string, address: string, value: CachedLabel): Promise<void> {
    await this.initialize();
    await this.pool.query(`INSERT INTO psm_address_labels (provider, address, label, source, expires_at)
      VALUES ($1, $2, $3, $4, $5::timestamptz)
      ON CONFLICT (provider, address) DO UPDATE SET label = EXCLUDED.label, source = EXCLUDED.source, expires_at = EXCLUDED.expires_at
      WHERE EXCLUDED.expires_at >= psm_address_labels.expires_at`,
      [provider, address.toLowerCase(), value.label, value.source, new Date(value.expiresAt).toISOString()]);
  }

  async saveDailyTargets(points: DailyTarget[]): Promise<void> {
    await this.initialize();
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      for (const point of points) await client.query(
        `INSERT INTO psm_daily_targets (sample_date, circulating_supply, target_usdc, checked_at, source, provisional)
         VALUES ($1::date, $2::numeric, $3::numeric, $4::timestamptz, $5, $6)
         ON CONFLICT (sample_date) DO UPDATE SET circulating_supply = EXCLUDED.circulating_supply,
           target_usdc = EXCLUDED.target_usdc, checked_at = EXCLUDED.checked_at,
           source = EXCLUDED.source, provisional = EXCLUDED.provisional
         WHERE EXCLUDED.checked_at >= psm_daily_targets.checked_at`,
        [point.date, point.circulatingSupply, point.targetUsdc, point.checkedAt, point.source, point.provisional]);
      await client.query("COMMIT");
    } catch (error) { await client.query("ROLLBACK"); throw error; }
    finally { client.release(); }
  }

  async loadDailyTargets(): Promise<DailyTarget[]> {
    await this.initialize();
    const result = await this.pool.query<{
      date: string; circulating_supply: string; target_usdc: string;
      checked_at: Date; source: string; provisional: boolean;
    }>(`SELECT to_char(sample_date, 'YYYY-MM-DD') AS date, circulating_supply::text,
        target_usdc::text, checked_at, source, provisional FROM psm_daily_targets ORDER BY sample_date`);
    return result.rows.map(row => ({ date: row.date, circulatingSupply: row.circulating_supply,
      targetUsdc: row.target_usdc, checkedAt: row.checked_at.toISOString(), source: row.source, provisional: row.provisional }));
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
      last_info_sent_at: Date | null;
      last_circulating_supply: string | null;
    }>(`SELECT level, last_checked_at, last_balance_usdc::text, last_info_sent_at, last_circulating_supply::text FROM slack_ratio_alert_state_v3 WHERE singleton = true`);
    const row = result.rows[0];
    if (!row) return undefined;
    return {
      level: row.level,
      lastCheckedAt: row.last_checked_at.toISOString(),
      lastBalanceUsdc: row.last_balance_usdc,
      ...(row.last_info_sent_at ? { lastInfoSentAt: row.last_info_sent_at.toISOString() } : {}),
      ...(row.last_circulating_supply ? { lastCirculatingSupply: row.last_circulating_supply } : {}),
    };
  }

  async saveSlackAlertState(state: SlackAlertState): Promise<void> {
    await this.initialize();
    await this.pool.query(
      `INSERT INTO slack_ratio_alert_state_v3 (singleton, level, last_checked_at, last_balance_usdc, last_info_sent_at, last_circulating_supply)
       VALUES (true, $1, $2::timestamptz, $3::numeric, $4::timestamptz, $5::numeric)
       ON CONFLICT (singleton) DO UPDATE SET
         level = EXCLUDED.level,
         last_checked_at = EXCLUDED.last_checked_at,
         last_balance_usdc = EXCLUDED.last_balance_usdc,
         last_info_sent_at = EXCLUDED.last_info_sent_at,
         last_circulating_supply = EXCLUDED.last_circulating_supply`,
      [state.level, state.lastCheckedAt, state.lastBalanceUsdc, state.lastInfoSentAt ?? null, state.lastCirculatingSupply ?? null],
    );
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  private async createSchema(): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(20261106, 2)");
      await client.query(`
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
      CREATE TABLE IF NOT EXISTS psm_intraday_snapshots (
        bucket timestamptz PRIMARY KEY,
        observed_at timestamptz NOT NULL,
        payload jsonb NOT NULL
      );
      CREATE INDEX IF NOT EXISTS psm_intraday_observed_idx ON psm_intraday_snapshots (observed_at);
      CREATE TABLE IF NOT EXISTS psm_address_labels (
        provider text NOT NULL,
        address text NOT NULL,
        label text,
        source text,
        expires_at timestamptz NOT NULL,
        PRIMARY KEY (provider, address)
      );
      CREATE INDEX IF NOT EXISTS psm_balance_snapshots_observed_at_idx
        ON psm_balance_snapshots (observed_at DESC);
      CREATE TABLE IF NOT EXISTS direct_exposure_snapshots (
        sample_date date PRIMARY KEY,
        total_usd double precision NOT NULL,
        venues jsonb NOT NULL,
        updated_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS psm_daily_targets (
        sample_date date PRIMARY KEY CHECK (sample_date >= DATE '2026-11-04'),
        circulating_supply numeric(40,18) NOT NULL CHECK (circulating_supply > 0),
        target_usdc numeric(30,6) NOT NULL CHECK (target_usdc > 0),
        checked_at timestamptz NOT NULL,
        source text NOT NULL,
        provisional boolean NOT NULL,
        CONSTRAINT psm_daily_targets_policy_check CHECK (target_usdc = ceil(circulating_supply * CASE WHEN sample_date >= DATE '2026-11-20' THEN 0.25 ELSE 0.30 END * 1000000) / 1000000)
      );
      ALTER TABLE psm_daily_targets DROP CONSTRAINT IF EXISTS psm_daily_targets_check;
      ALTER TABLE psm_daily_targets DROP CONSTRAINT IF EXISTS psm_daily_targets_policy_check;
      UPDATE psm_daily_targets SET target_usdc = ceil(circulating_supply * 0.25 * 1000000) / 1000000
        WHERE sample_date >= DATE '2026-11-20' AND target_usdc <> ceil(circulating_supply * 0.25 * 1000000) / 1000000;
      ALTER TABLE psm_daily_targets ADD CONSTRAINT psm_daily_targets_policy_check CHECK
        (target_usdc = ceil(circulating_supply * CASE WHEN sample_date >= DATE '2026-11-20' THEN 0.25 ELSE 0.30 END * 1000000) / 1000000);
      WITH revised AS (
        SELECT bucket, payload, (payload#>>'{reserve,totalBalanceUsdc}')::numeric AS balance,
          (payload#>>'{reserve,circulatingSupply}')::numeric AS supply,
          ceil((payload#>>'{reserve,circulatingSupply}')::numeric * 0.25 * 1000000) / 1000000 AS target
        FROM psm_intraday_snapshots WHERE observed_at >= '2026-11-20T00:00:00Z'::timestamptz AND observed_at < '2026-11-21T00:00:00Z'::timestamptz
          AND payload#>>'{reserve,targetPercent}' IS DISTINCT FROM '25'
          AND (payload#>>'{reserve,circulatingSupply}')::numeric > 0
      ) UPDATE psm_intraday_snapshots AS s SET payload = v.payload || jsonb_build_object('reserve', (v.payload->'reserve') || jsonb_build_object(
        'targetPercent',25,'limitUsdc',v.target::text,'remainingUsdc',(v.target-v.balance)::text,
        'utilizationPercent',v.balance/v.target*100,'yellowPercent',96,'orangePercent',88,
        'reserveBand',CASE WHEN v.balance*100>=v.supply*25 THEN 'healthy' WHEN v.balance*100>=v.supply*24 THEN 'below_25' WHEN v.balance*100>=v.supply*22 THEN 'below_24' WHEN v.balance*100>=v.supply*20 THEN 'below_22' WHEN v.balance*100>=v.supply*18 THEN 'below_20' ELSE 'below_18' END,
        'status',CASE WHEN v.balance*100>=v.supply*25 THEN 'healthy' WHEN v.balance*100>=v.supply*24 THEN 'warning' WHEN v.balance*100>=v.supply*22 THEN 'critical' ELSE 'low' END))
        FROM revised v WHERE s.bucket=v.bucket;
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
          -- Start policy v2 from the healthy band so its first check reports any
          -- already-active threshold instead of silently adopting it.
          UPDATE slack_alert_state SET level = 'healthy';
          ALTER TABLE slack_alert_state
            ADD CONSTRAINT slack_alert_state_level_check
            CHECK (level IN ('healthy', 'below_4_0', 'below_3_9', 'below_3_8', 'below_3_7', 'below_3_6', 'below_3_5'));
        END IF;
      END;
      $migration$;

      CREATE TABLE IF NOT EXISTS slack_ratio_alert_state (
        singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
        level text NOT NULL CHECK (level IN ('healthy', 'below_30', 'below_28', 'below_25', 'below_20')),
        last_checked_at timestamptz NOT NULL,
        last_balance_usdc numeric(30, 6) NOT NULL,
        last_info_sent_at timestamptz,
        last_circulating_supply numeric(40, 18)
      );
      -- Preserve delivery history once without changing the old worker's table or bands.
      INSERT INTO slack_ratio_alert_state (singleton, level, last_checked_at, last_balance_usdc, last_info_sent_at)
        SELECT singleton, 'healthy', last_checked_at, last_balance_usdc, last_info_sent_at
        FROM slack_alert_state
      ON CONFLICT (singleton) DO NOTHING;
      CREATE TABLE IF NOT EXISTS slack_ratio_alert_state_v3 (
        singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
        level text NOT NULL CHECK (level IN ('healthy','below_25','below_24','below_22','below_20','below_18')),
        last_checked_at timestamptz NOT NULL, last_balance_usdc numeric(30,6) NOT NULL,
        last_info_sent_at timestamptz, last_circulating_supply numeric(40,18)
      );
      INSERT INTO slack_ratio_alert_state_v3 (singleton,level,last_checked_at,last_balance_usdc,last_info_sent_at,last_circulating_supply)
        SELECT singleton,'healthy',last_checked_at,last_balance_usdc,last_info_sent_at,last_circulating_supply FROM slack_ratio_alert_state
      ON CONFLICT(singleton) DO NOTHING;

    `);
      await client.query("COMMIT");
    } catch (error) { await client.query("ROLLBACK"); throw error; }
    finally { client.release(); }
  }
}
