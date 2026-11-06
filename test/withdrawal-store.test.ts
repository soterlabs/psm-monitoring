import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { it } from "node:test";
import { Pool } from "pg";
import { WithdrawalStore } from "../src/withdrawal-store.js";
import type { WithdrawalEvent, WithdrawalIndexState } from "../src/withdrawals.js";

const url = process.env.WITHDRAWAL_TEST_DATABASE_URL;
it("Postgres commits events and cursors atomically and rejects competing stale workers", { skip: !url }, async () => {
  const store = new WithdrawalStore(url!);
  const other = new WithdrawalStore(url!);
  const cleanup = new Pool({ connectionString: url! });
  const psm = `0x${randomBytes(20).toString("hex")}`;
  const time = "2026-11-06T12:00:00.000Z";
  const state: WithdrawalIndexState = { startBlock: 1, startTimestamp: time, nextBlock: 10, targetBlock: 30, throughTimestamp: time, updatedAt: time };
  const event = (amountRaw: string, txHash: string): WithdrawalEvent => ({ txHash, logIndex: 1, blockNumber: 11, timestamp: time, recipient: psm, amountRaw });
  try {
    await store.savePage(psm, undefined, [], state);
    await other.load(psm);
    await Promise.all([
      store.savePage(psm, 10, [event("10", "first")], { ...state, nextBlock: 20 }),
      other.savePage(psm, 10, [event("20", "second")], { ...state, nextBlock: 20 }),
    ]);
    const totals = await store.totals(psm, time, time);
    assert.equal(totals.length, 1);
    assert.equal(totals[0]?.swaps, 1);
    assert.ok(["10", "20"].includes(totals[0]!.amountRaw));
    await assert.rejects(store.savePage(psm, 20, [event("0", "invalid")], { ...state, nextBlock: 30 }));
    assert.equal((await store.load(psm))?.nextBlock, 20);
    assert.deepEqual(await store.totals(psm, time, time), totals);
    // Reprocessing an already stored event is idempotent.
    await store.savePage(psm, 20, [event(totals[0]!.amountRaw, totals[0]!.amountRaw === "10" ? "first" : "second")], { ...state, nextBlock: 30 });
    assert.deepEqual(await store.totals(psm, time, time), totals);
    const paidBack = BigInt(totals[0]!.amountRaw) - 1n;
    await store.savePage(psm, 30, [event((-paidBack).toString(), "repayment")], { ...state, nextBlock: 40 });
    const net = await store.totals(psm, time, time);
    assert.equal(net[0]?.amountRaw, "1");
    assert.equal(net[0]?.replenishedRaw, paidBack.toString());
    await store.savePage(psm, 40, [event("-1", "fully-repaid")], { ...state, nextBlock: 50 });
    assert.deepEqual(await store.totals(psm, time, time), []);
  } finally {
    await cleanup.query("DELETE FROM psm_usdc_flow_events WHERE psm_address = $1", [psm]);
    await cleanup.query("DELETE FROM psm_usdc_flow_index WHERE psm_address = $1", [psm]);
    await Promise.all([store.close(), other.close(), cleanup.end()]);
  }
});

it("Postgres prevents simultaneous web/cron refreshes and shares cooldown across processes", { skip: !url }, async () => {
  const store = new WithdrawalStore(url!), other = new WithdrawalStore(url!);
  const cleanup = new Pool({ connectionString: url! });
  const psm = `0x${randomBytes(20).toString("hex")}`;
  let release!: () => void, entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const pending = new Promise<void>(resolve => { release = resolve; });
  try {
    const first = store.withRefreshLock(psm, async () => { entered(); await pending; });
    await started;
    let competingCalls = 0;
    await other.withRefreshLock(psm, async () => { competingCalls++; });
    assert.equal(competingCalls, 0);
    release(); await first;
    const cooldown = { retryAt: "2026-11-06T13:00:00.000Z", failures: 2,
      error: { message: "rate limited", at: "2026-11-06T12:00:00.000Z", code: "rate_limited" as const } };
    await store.withRefreshLock(psm, () => store.saveRefreshState(psm, cooldown));
    assert.deepEqual(await other.loadRefreshState(psm), cooldown);
    await assert.rejects(store.withRefreshLock(psm, async () => { throw new Error("provider failed"); }), /provider failed/);
    await other.withRefreshLock(psm, async () => { competingCalls++; });
    assert.equal(competingCalls, 1, "a failed refresh releases its session lock");
  } finally {
    release?.();
    await cleanup.query("DELETE FROM psm_usdc_flow_refresh WHERE psm_address = $1", [psm]);
    await Promise.all([store.close(), other.close(), cleanup.end()]);
  }
});
