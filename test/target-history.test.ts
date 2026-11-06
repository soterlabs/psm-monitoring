import assert from "node:assert/strict";
import { it } from "node:test";
import { randomBytes } from "node:crypto";
import { Pool } from "pg";
import { SnapshotStore } from "../src/database.js";
import { applyDailyTargets, readDailyTargets, TargetHistory } from "../src/target-history.js";
import type { HistorySeries } from "../src/types.js";

const now = new Date("2026-11-06T12:00:00Z");
const row = (date: string, supply: string) => ({ date, total_circulating: supply, circulating_usds: supply, circulating_dai: "0" });
const response = (data: unknown) => (async () => new Response(JSON.stringify({ data }))) as typeof fetch;
const series: HistorySeries = { range: "7d", interval: "daily", generatedAt: now.toISOString(), limitUsdc: "4000000000",
  points: ["2026-11-03T23:59:59Z", "2026-11-04T00:00:00Z", "2026-11-05T00:00:00Z", "2026-11-06T00:00:00Z"].map(timestamp => ({ timestamp, blockNumber: "1", balanceUsdc: "3000000000", utilizationPercent: 75 })) };

it("keeps 4B through Nov 3 UTC and uses each day's supply from Nov 4, leaving missing dates explicit", async () => {
  const targets = await readDailyTargets(response([row("2026-11-03", "20000000000"), row("2026-11-04", "10000000000.000000000000000001"), row("2026-11-06", "8000000000")]), now);
  const points = applyDailyTargets(series, targets).points;
  assert.deepEqual(points.map(p => p.targetUsdc), ["4000000000", "3000000000.000001", null, "2400000000"]);
  assert.equal(points[0]?.utilizationPercent, 75);
  assert.equal(points[2]?.utilizationPercent, null);
  assert.equal(points[3]?.utilizationPercent, 125);
  assert.equal(points[1]?.targetProvisional, false);
  assert.equal(points[3]?.targetProvisional, true);
  assert.equal(points[1]?.circulatingSupply, "10000000000.000000000000000001");
});

it("rejects mismatched components, duplicate dates, invalid dates, and failed responses", async () => {
  await assert.rejects(readDailyTargets(response([{ ...row("2026-11-04", "10"), circulating_dai: "1" }]), now), /reconcile/);
  await assert.rejects(readDailyTargets(response([row("2026-11-04", "10"), row("2026-11-04", "20")]), now), /Duplicate/);
  await assert.rejects(readDailyTargets(response([row("2026-11-31", "10")]), now), /Invalid/);
  await assert.rejects(readDailyTargets((async () => new Response("", { status: 503 })) as typeof fetch, now), /503/);
});

it("places the policy switch at Nov 4 midnight even between monthly balance samples", async () => {
  const targets = await readDailyTargets(response([row("2026-11-04", "9000000000"), row("2026-11-05", "8000000000"), row("2026-11-06", "7000000000")]), now);
  const monthly = { ...series, points: [series.points[0]!, series.points[3]!] };
  const curve = applyDailyTargets(monthly, targets).targetPoints;
  assert.deepEqual(curve.map(p => [p.timestamp, p.targetUsdc]), [
    ["2026-11-03T23:59:59Z", "4000000000"],
    ["2026-11-04T00:00:00.000Z", "2700000000"],
    ["2026-11-05T00:00:00.000Z", "2400000000"],
    ["2026-11-06T00:00:00.000Z", "2100000000"],
  ]);
});

const databaseUrl = process.env.WITHDRAWAL_TEST_DATABASE_URL;
it("persists and reloads daily targets, finalizes provisional days, rejects stale writes and survives an API outage", { skip: !databaseUrl }, async () => {
  const schema = `target_test_${randomBytes(6).toString("hex")}`;
  const admin = new Pool({ connectionString: databaseUrl! });
  const url = new URL(databaseUrl!); url.searchParams.set("options", `-c search_path=${schema}`);
  let store: SnapshotStore | undefined;
  try {
    await admin.query(`CREATE SCHEMA ${schema}`);
    store = new SnapshotStore(url.toString());
    const initial = await readDailyTargets(response([row("2026-11-06", "8000000000")]), now);
    await store.saveDailyTargets(initial);
    const next = await readDailyTargets(response([row("2026-11-06", "8100000000"), row("2026-11-07", "8200000000")]), new Date("2026-11-07T12:00:00Z"));
    await store.saveDailyTargets(next);
    await store.saveDailyTargets(initial);
    await store.close(); store = new SnapshotStore(url.toString());
    const saved = await store.loadDailyTargets();
    assert.equal(saved.length, 2);
    assert.equal(saved[0]?.circulatingSupply, "8100000000.000000000000000000");
    assert.equal(saved[0]?.targetUsdc, "2430000000.000000");
    assert.equal(saved[0]?.provisional, false);
    assert.equal(saved[1]?.provisional, true);
    const monitor = new TargetHistory(store, async () => { throw new Error("offline"); });
    await monitor.refresh();
    assert.equal(monitor.targets.length, 2);
    assert.equal(monitor.lastError?.message, "offline");
    await assert.rejects(store.saveDailyTargets([{ ...next[0]!, targetUsdc: "1" }]), /check constraint/);
  } finally {
    await store?.close(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end();
  }
});
