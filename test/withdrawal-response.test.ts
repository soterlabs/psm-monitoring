import assert from "node:assert/strict";
import { it } from "node:test";
import type { PublicClient } from "viem";
import { loadConfig } from "../src/config.js";
import { canonicalPocket, canonicalUsdc, MemoryWithdrawalStorage, WithdrawalMonitor, withdrawalResponse, type WithdrawalIndexState, type WithdrawalPage } from "../src/withdrawals.js";
import { WithdrawalRateLimitError } from "../src/withdrawal-rate-limit.js";

function config() {
  const previous = process.env.ETH_RPC;
  process.env.ETH_RPC = "https://example.com";
  try { return loadConfig(); }
  finally { if (previous === undefined) delete process.env.ETH_RPC; else process.env.ETH_RPC = previous; }
}
const client = {
  readContract: async ({ functionName }: { functionName: string }) => functionName === "gem" ? canonicalUsdc : canonicalPocket,
  getBlock: async () => ({ number: 100n, timestamp: 1793966400n, hash: "0x123" }),
} as unknown as PublicClient;
const state: WithdrawalIndexState = { startBlock: 1, startTimestamp: "2026-01-01T00:00:00.000Z", nextBlock: 50, targetBlock: 100,
  throughTimestamp: "2026-11-06T12:00:00.000Z", updatedAt: new Date().toISOString(), mode: "backfill" };

it("serves a covered range while an older-history request is still pending", { timeout: 1000 }, async () => {
  const cfg = config(), store = new MemoryWithdrawalStorage();
  await store.savePage(cfg.psmAddress.toLowerCase(), undefined, [], state);
  let resolve!: (page: WithdrawalPage) => void;
  const pending = new Promise<WithdrawalPage>(done => { resolve = done; });
  const monitor = new WithdrawalMonitor(client, cfg, store, async () => pending);
  const response = await withdrawalResponse(monitor, "7d");
  assert.equal(response.status, 200); assert.equal(response.body.snapshot.complete, true);
  assert.equal(response.body.snapshot.syncPending, true);
  resolve({ next_block: 101, data: [] }); await monitor.refresh();
  assert.equal((await monitor.result("7d")).syncPending, false);
});

it("returns loading within its wait budget and retains an initial in-flight page", { timeout: 1000 }, async () => {
  const cfg = config(), store = new MemoryWithdrawalStorage();
  await store.savePage(cfg.psmAddress.toLowerCase(), undefined, [], { ...state, startTimestamp: "2026-11-06T12:00:00.001Z" });
  let resolve!: (page: WithdrawalPage) => void;
  const pending = new Promise<WithdrawalPage>(done => { resolve = done; });
  const monitor = new WithdrawalMonitor(client, cfg, store, async () => pending);
  const response = await withdrawalResponse(monitor, "7d", 5);
  assert.equal(response.status, 202); assert.equal(response.body.snapshot.complete, false);
  resolve({ next_block: 101, data: [] }); await monitor.refresh();
});

it("captures a refresh failure after a cached response without discarding rankings", async () => {
  const cfg = config(), store = new MemoryWithdrawalStorage();
  await store.savePage(cfg.psmAddress.toLowerCase(), undefined, [], state);
  const monitor = new WithdrawalMonitor(client, cfg, store, async () => { throw new Error("provider unavailable"); });
  assert.equal((await withdrawalResponse(monitor, "7d")).status, 200);
  await assert.rejects(monitor.refresh(), /provider unavailable/);
  assert.equal(monitor.lastError?.message, "provider unavailable");
  const response = await withdrawalResponse(monitor, "7d");
  assert.equal(response.status, 200); assert.match(response.body.error!.message, /provider unavailable/);
});

it("shares rate-limit cooldown across monitor restarts and preserves the cursor and cached rankings", async () => {
  const cfg = config(), store = new MemoryWithdrawalStorage();
  const psm = cfg.psmAddress.toLowerCase();
  await store.savePage(psm, undefined, [], state);
  let requests = 0;
  const fetchPage = async () => { requests++; throw new WithdrawalRateLimitError("600"); };
  const monitor = new WithdrawalMonitor(client, cfg, store, fetchPage);
  await assert.rejects(monitor.refresh(), WithdrawalRateLimitError);
  const restarted = new WithdrawalMonitor(client, cfg, store, fetchPage);
  await restarted.refresh();
  assert.equal(requests, 1);
  assert.equal(restarted.retryAt, monitor.retryAt);
  assert.equal((await store.load(psm))?.nextBlock, state.nextBlock);
  const response = await withdrawalResponse(restarted, "7d");
  assert.equal(response.status, 200);
  assert.equal(response.body.error?.code, "rate_limited");
  assert.equal(response.body.snapshot.asOf, state.throughTimestamp);
  assert.ok(Date.parse(response.body.retryAt!) > Date.now() + 590_000);
  // A later successful worker clears the shared failure, including for the old web monitor.
  await store.saveRefreshState(psm, { retryAt: null, failures: 0, error: null });
  const recovered = new WithdrawalMonitor(client, cfg, store, async () => ({ next_block: 101, data: [] }));
  await recovered.refresh();
  assert.equal((await store.loadRefreshState(psm))?.error, null);
  const recoveredResponse = await withdrawalResponse(monitor, "7d");
  assert.equal(recoveredResponse.body.error, null, "a cached response immediately observes another worker's recovery");
  assert.equal(recoveredResponse.body.retryAt, null);
  await monitor.refresh(); // Already indexed and fresh: no provider call.
  assert.equal(monitor.lastError, undefined);
});

it("finishes a paginated head refresh even when 180-day history is already covered", async () => {
  const cfg = config(), store = new MemoryWithdrawalStorage();
  await store.savePage(cfg.psmAddress.toLowerCase(), undefined, [], { ...state, mode: "head" });
  let pages = 0;
  const monitor = new WithdrawalMonitor(client, cfg, store, async () => ({ next_block: ++pages === 1 ? 75 : 101, data: [] }));
  for (;;) {
    await monitor.refresh();
    const result = await monitor.result("180d");
    assert.equal(result.complete, true, "old history is available throughout the head refresh");
    if (result.complete && !result.syncPending) break;
    assert.ok(pages < 3);
  }
  assert.equal(pages, 2);
  assert.equal((await store.load(cfg.psmAddress.toLowerCase()))?.nextBlock, 101);
});
