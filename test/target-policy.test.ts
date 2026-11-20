import assert from "node:assert/strict";
import { it } from "node:test";
import { reserveTargetRaw, targetPercentAt } from "../src/supply.js";
import { intradayHistory, type IntradaySnapshot } from "../src/intraday.js";
import { applyDailyTargets } from "../src/target-history.js";

it("switches at Nov 20 midnight UTC, with exact micro-USDC rounding", () => {
  assert.equal(targetPercentAt("2026-11-19T23:59:59Z"), 30);
  assert.equal(targetPercentAt("2026-11-20T00:00:00Z"), 25);
  assert.equal(reserveTargetRaw("10000000000.000000000000000001"), 2500000000000001n);
});

it("recomputes targets from each saved intraday supply and preserves earlier policy and balances", () => {
  const samples = ["2026-11-19T23:50:00Z", "2026-11-20T00:00:00Z", "2026-11-20T00:10:00Z"].map((time, i) => ({
    observedAt: time, reserve: { checkedAt: time, blockTimestamp: i === 1 ? "2026-11-19T23:59:59Z" : time,
      blockNumber: String(i), totalBalanceUsdc: "2000000000", circulatingSupply: i === 2 ? "12000000000" : "10000000000", supplyCheckedAt: time },
  } as IntradaySnapshot));
  const series = intradayHistory(samples);
  assert.deepEqual(series.points.map(p => p.targetUsdc), ["3000000000", "2500000000", "3000000000"]);
  assert.deepEqual(series.points.map(p => p.balanceUsdc), Array(3).fill("2000000000"));
  assert.equal(series.targetPoints[1]?.timestamp, "2026-11-20T00:00:00Z");
});

it("preserves 4B and 30% daily targets while using 25% from Nov 20 even for previously saved rows", () => {
  const dates = ["2026-11-03", "2026-11-19", "2026-11-20"];
  const points = dates.map(date => ({ timestamp: date + "T12:00:00Z", blockNumber: "1", balanceUsdc: "2000000000", utilizationPercent: 0 }));
  const targets = dates.map(date => ({ date, circulatingSupply: "10000000000", targetUsdc: "3000000000", source: "test", checkedAt: date + "T12:00:00Z", provisional: false }));
  const series = applyDailyTargets({ range: "7d", interval: "daily", generatedAt: points[2]!.timestamp, limitUsdc: "0", points }, targets);
  assert.deepEqual(series.points.map(p => p.targetUsdc), ["4000000000", "3000000000", "2500000000"]);
});

import { Pool } from "pg";
import { randomBytes } from "node:crypto";
import { SnapshotStore } from "../src/database.js";
const databaseUrl = process.env.WITHDRAWAL_TEST_DATABASE_URL;
it("migrates saved targets from midnight without altering balances or earlier targets, and preserves old alert state", { skip: !databaseUrl }, async () => {
  const schema = `policy_${randomBytes(6).toString("hex")}`;
  const admin = new Pool({ connectionString: databaseUrl! });
  const url = new URL(databaseUrl!); url.searchParams.set("options", `-c search_path=${schema}`);
  let store = new SnapshotStore(url.toString());
  try {
    await admin.query(`CREATE SCHEMA ${schema}`);
    await store.initialize();
    // Recreate the preceding deployment's constraint and rows.
    await admin.query(`ALTER TABLE ${schema}.psm_daily_targets DROP CONSTRAINT psm_daily_targets_policy_check;
      ALTER TABLE ${schema}.psm_daily_targets ADD CHECK (target_usdc = ceil(circulating_supply * 0.30 * 1000000) / 1000000);
      INSERT INTO ${schema}.psm_daily_targets VALUES ('2026-11-19',10000000000,3000000000,now(),'test',false),('2026-11-20',12000000000,3600000000,now(),'test',true);
      INSERT INTO ${schema}.slack_ratio_alert_state VALUES (true,'below_28','2026-11-20T10:00:00Z',2300000000,'2026-11-20T00:00:00Z',10000000000)`);
    for (const [time,supply] of [["2026-11-19T23:50:00Z","10000000000"],["2026-11-20T00:00:00Z","10000000000"],["2026-11-20T00:10:00Z","12000000000"]]) {
      await store.saveIntraday({ observedAt: time, reserve: { checkedAt: time, totalBalanceUsdc: "2300000000", circulatingSupply: supply, targetPercent: 30, limitUsdc: "3000000000" } } as IntradaySnapshot);
    }
    await store.close(); store = new SnapshotStore(url.toString());
    await store.initialize();
    const daily = await store.loadDailyTargets();
    assert.deepEqual(daily.map(t=>Number(t.targetUsdc)), [3000000000,3000000000]);
    const rows = await store.loadIntraday(new Date("2026-11-20T01:00:00Z"),7);
    assert.deepEqual(rows.map(r=>Number(r.reserve.limitUsdc)),[3000000000,2500000000,3000000000]);
    assert.deepEqual(rows.map(r=>r.reserve.totalBalanceUsdc),Array(3).fill("2300000000"));
    assert.equal(rows[1]?.reserve.reserveBand,"below_24");
    assert.equal((await store.loadSlackAlertState())?.level,"healthy");
    assert.equal((await store.loadSlackAlertState())?.lastCirculatingSupply,"10000000000.000000000000000000");
    const state = (await store.loadSlackAlertState())!;
    await store.saveSlackAlertState({...state,level:"below_18"});
    await store.close(); store = new SnapshotStore(url.toString()); await store.initialize();
    assert.equal((await store.loadSlackAlertState())?.level,"below_18");
    assert.equal((await admin.query(`SELECT level FROM ${schema}.slack_ratio_alert_state`)).rows[0].level,"below_28");
  } finally { await store.close(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); }
});
