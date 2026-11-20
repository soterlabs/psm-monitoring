import assert from "node:assert/strict";
import { it } from "node:test";
import { randomBytes } from "node:crypto";
import { Pool } from "pg";
import { SnapshotStore } from "../src/database.js";
import { intradayHistory, type IntradaySnapshot } from "../src/intraday.js";
import { MemoryWithdrawalStorage } from "../src/withdrawals.js";
import { dashboardHtml } from "../src/dashboard.js";
import { Script } from "node:vm";

it("places the depositor card third, uses shared table styling, and offers the new option on both flow cards", () => {
  assert.ok(dashboardHtml.indexOf('id="withdrawals"') < dashboardHtml.indexOf('id="depositors"'));
  assert.ok(dashboardHtml.indexOf('id="depositors"') < dashboardHtml.indexOf('id="exposure"'));
  assert.equal([...dashboardHtml.matchAll(/value="24h"/g)].length, 3);
  const ids = [...dashboardHtml.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]);
  assert.equal(new Set(ids).size, ids.length);
  for (const script of dashboardHtml.matchAll(/<script>([\s\S]*?)<\/script>/g)) new Script(script[1]!);
});

it("ranks depositors by replenishments minus withdrawals, excluding withdrawers and neutral accounts", async () => {
  const store = new MemoryWithdrawalStorage();
  const time = "2026-11-20T12:00:00Z";
  const events = [["a", "-100"], ["a", "20"], ["b", "-200"], ["b", "50"], ["c", "10"], ["d", "-10"], ["d", "10"]].map(([recipient, amountRaw], i) => ({ recipient: recipient!, amountRaw: amountRaw!, txHash: String(i), logIndex: i, blockNumber: 1, timestamp: time }));
  await store.savePage("psm", undefined, events, { startBlock: 1, nextBlock: 2, targetBlock: 1, startTimestamp: time, throughTimestamp: time, updatedAt: time });
  assert.deepEqual((await store.totals("psm", time, time, "depositors")).map(row => [row.address, row.amountRaw]), [["b", "-150"], ["a", "-80"]]);
  assert.deepEqual((await store.totals("psm", time, time)).map(row => row.address), ["c"]);
});

const sample = (time: string, balance: string): IntradaySnapshot => ({ observedAt: time,
  reserve: { blockTimestamp: time, blockNumber: "1", totalBalanceUsdc: balance, limitUsdc: "2600000000", circulatingSupply: "8666666666", utilizationPercent: 50 },
  withdrawals: { complete: true, rows: [] }, depositors: { complete: true, rows: [] },
} as unknown as IntradaySnapshot);
it("projects recorded intraday balances and targets without generating missing points", () => {
  assert.deepEqual(intradayHistory([]).points, []);
  const history = intradayHistory([sample("2026-11-20T12:00:00Z", "1000000000"), sample("2026-11-20T12:30:00Z", "1100000000")]);
  assert.equal(history.points.length, 2);
  assert.equal(history.points[1]?.targetUsdc, "2600000000");
  assert.equal(history.points[1]?.balanceUsdc, "1100000000");
});

const url = process.env.WITHDRAWAL_TEST_DATABASE_URL;
it("stores one snapshot per ten-minute bucket and loads only the requested last 24h", { skip: !url }, async () => {
  const schema = `intraday_${randomBytes(6).toString("hex")}`;
  const admin = new Pool({ connectionString: url! });
  const connection = new URL(url!); connection.searchParams.set("options", `-c search_path=${schema}`);
  const store = new SnapshotStore(connection.toString());
  try {
    await admin.query(`CREATE SCHEMA ${schema}`);
    await store.saveIntraday(sample("2026-11-20T12:01:00Z", "10"));
    await store.saveIntraday(sample("2026-11-20T12:02:00Z", "20"));
    await store.saveIntraday(sample("2026-11-20T12:01:30Z", "15"));
    await store.saveIntraday(sample("2026-11-19T11:00:00Z", "1"));
    const rows = await store.loadIntraday(new Date("2026-11-20T12:03:00Z"));
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.reserve.totalBalanceUsdc, "20");
  } finally { await store.close(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); }
});
