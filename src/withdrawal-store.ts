import { Pool } from "pg";
import type { WithdrawalEvent, WithdrawalIndexState, WithdrawalStorage, WithdrawalTotal } from "./withdrawals.js";

export class WithdrawalStore implements WithdrawalStorage {
  private readonly pool: Pool;
  private initialized: Promise<void> | undefined;
  constructor(databaseUrl: string) {
    this.pool = new Pool({ connectionString: databaseUrl, max: 2, connectionTimeoutMillis: 5_000, statement_timeout: 15_000,
      idleTimeoutMillis: 10_000, allowExitOnIdle: true });
  }
  static fromEnvironment(): WithdrawalStore | undefined {
    return process.env.DATABASE_URL ? new WithdrawalStore(process.env.DATABASE_URL) : undefined;
  }
  private async initialize(): Promise<void> {
    this.initialized ??= this.createSchema().catch(error => { this.initialized = undefined; throw error; });
    await this.initialized;
  }
  private async createSchema(): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(20261106, 1)");
      await client.query(`
      CREATE TABLE IF NOT EXISTS psm_usdc_flow_events (
        psm_address text NOT NULL, tx_hash text NOT NULL, log_index integer NOT NULL,
        block_number bigint NOT NULL, observed_at timestamptz NOT NULL,
        recipient text NOT NULL, amount_raw numeric(78,0) NOT NULL CHECK (amount_raw <> 0),
        PRIMARY KEY (psm_address, tx_hash, log_index, recipient)
      );
      CREATE INDEX IF NOT EXISTS psm_usdc_flow_events_time_idx ON psm_usdc_flow_events (psm_address, observed_at);
      CREATE TABLE IF NOT EXISTS psm_usdc_flow_index (
        psm_address text PRIMARY KEY, state jsonb NOT NULL
      );
    `);
      await client.query("COMMIT");
    } catch (error) { await client.query("ROLLBACK"); throw error; }
    finally { client.release(); }
  }
  async load(psm: string): Promise<WithdrawalIndexState | undefined> {
    await this.initialize();
    const result = await this.pool.query<{ state: WithdrawalIndexState }>("SELECT state FROM psm_usdc_flow_index WHERE psm_address = $1", [psm]);
    return result.rows[0]?.state;
  }
  async savePage(psm: string, expected: number | undefined, events: WithdrawalEvent[], state: WithdrawalIndexState): Promise<void> {
    await this.initialize();
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`psm-withdrawals:${psm}`]);
      const current = await client.query<{ state: WithdrawalIndexState }>("SELECT state FROM psm_usdc_flow_index WHERE psm_address = $1", [psm]);
      if (current.rows[0]?.state.nextBlock !== expected) { await client.query("ROLLBACK"); return; }
      await client.query(`
        INSERT INTO psm_usdc_flow_events (psm_address, tx_hash, log_index, block_number, observed_at, recipient, amount_raw)
        SELECT $1, x."txHash", x."logIndex", x."blockNumber", x.timestamp::timestamptz, x.recipient, x."amountRaw"::numeric
        FROM jsonb_to_recordset($2::jsonb) AS x("txHash" text, "logIndex" integer, "blockNumber" bigint, timestamp text, recipient text, "amountRaw" text)
        ON CONFLICT (psm_address, tx_hash, log_index, recipient) DO NOTHING`, [psm, JSON.stringify(events)]);
      await client.query(`INSERT INTO psm_usdc_flow_index (psm_address, state) VALUES ($1, $2::jsonb)
        ON CONFLICT (psm_address) DO UPDATE SET state = EXCLUDED.state`, [psm, JSON.stringify(state)]);
      await client.query("COMMIT");
    } catch (error) { await client.query("ROLLBACK"); throw error; }
    finally { client.release(); }
  }
  async totals(psm: string, from: string, through: string): Promise<WithdrawalTotal[]> {
    await this.initialize();
    const result = await this.pool.query<{ address: string; amount: string; withdrawn: string; replenished: string; swaps: number }>(`
      SELECT recipient AS address, SUM(amount_raw)::text AS amount,
        SUM(GREATEST(amount_raw, 0))::text AS withdrawn, SUM(GREATEST(-amount_raw, 0))::text AS replenished, COUNT(*)::integer AS swaps
      FROM psm_usdc_flow_events WHERE psm_address = $1 AND observed_at >= $2::timestamptz AND observed_at <= $3::timestamptz
      GROUP BY recipient HAVING SUM(amount_raw) > 0 ORDER BY SUM(amount_raw) DESC, recipient ASC LIMIT 20`, [psm, from, through]);
    return result.rows.map(row => ({ address: row.address, amountRaw: row.amount, withdrawnRaw: row.withdrawn, replenishedRaw: row.replenished, swaps: row.swaps }));
  }
  async close(): Promise<void> { await this.pool.end(); }
}
