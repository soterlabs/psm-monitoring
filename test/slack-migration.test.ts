import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { it } from "node:test";
import { Pool } from "pg";
import { SnapshotStore } from "../src/database.js";

const databaseUrl = process.env.WITHDRAWAL_TEST_DATABASE_URL;
it("migrates absolute Slack bands once, preserving delivery times and recording the supply denominator", { skip: !databaseUrl }, async () => {
  const schema = `slack_test_${randomBytes(6).toString("hex")}`;
  const admin = new Pool({ connectionString: databaseUrl! });
  const url = new URL(databaseUrl!); url.searchParams.set("options", `-c search_path=${schema}`);
  let store: SnapshotStore | undefined;
  try {
    await admin.query(`CREATE SCHEMA ${schema}`);
    await admin.query(`CREATE TABLE ${schema}.slack_alert_state (
      singleton boolean PRIMARY KEY DEFAULT true, level text NOT NULL CONSTRAINT slack_alert_state_level_check
      CHECK (level IN ('healthy','below_4_0','below_3_8','below_3_5')), last_checked_at timestamptz NOT NULL,
      last_balance_usdc numeric(30,6) NOT NULL, last_info_sent_at timestamptz NOT NULL);
      INSERT INTO ${schema}.slack_alert_state VALUES (true,'below_3_8','2026-11-06T12:00:00Z',2400000000,'2026-11-06T00:00:00Z')`);
    store = new SnapshotStore(url.toString());
    const migrated = await store.loadSlackAlertState();
    assert.equal(migrated?.level, "healthy");
    assert.equal(migrated?.lastInfoSentAt, "2026-11-06T00:00:00.000Z");
    assert.equal(migrated?.lastBalanceUsdc, "2400000000.000000");
    const legacy = await admin.query(`SELECT level FROM ${schema}.slack_alert_state`);
    assert.equal(legacy.rows[0].level, "below_3_8", "the absolute worker's state remains intact during rollout");
    await admin.query(`UPDATE ${schema}.slack_alert_state SET level = 'below_3_5'`);
    await store.saveSlackAlertState({ ...migrated!, level: "below_25", lastCirculatingSupply: "10000000000.123456789012345678" });
    await store.close(); store = new SnapshotStore(url.toString());
    const restarted = await store.loadSlackAlertState();
    assert.equal(restarted?.level, "below_25");
    assert.equal(restarted?.lastCirculatingSupply, "10000000000.123456789012345678");
  } finally {
    await store?.close();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  }
});

it("persists the first ratio check before any information message has been delivered", { skip: !databaseUrl }, async () => {
  const schema = `slack_test_${randomBytes(6).toString("hex")}`;
  const admin = new Pool({ connectionString: databaseUrl! });
  const url = new URL(databaseUrl!); url.searchParams.set("options", `-c search_path=${schema}`);
  let store: SnapshotStore | undefined;
  try {
    await admin.query(`CREATE SCHEMA ${schema}`);
    store = new SnapshotStore(url.toString());
    await store.saveSlackAlertState({ level: "below_25", lastCheckedAt: "2026-11-06T12:00:00Z", lastBalanceUsdc: "2400000000", lastCirculatingSupply: "10000000000" });
    const first = await store.loadSlackAlertState();
    assert.equal(first?.level, "below_25"); assert.equal(first?.lastInfoSentAt, undefined);
  } finally {
    await store?.close(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end();
  }
});
