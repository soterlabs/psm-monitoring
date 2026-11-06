import assert from "node:assert/strict";
import { it } from "node:test";
import type { PublicClient } from "viem";
import { loadConfig } from "../src/config.js";
import { canonicalPocket, canonicalUsdc, MemoryWithdrawalStorage, WithdrawalMonitor, withdrawalResponse, type WithdrawalIndexState, type WithdrawalPage } from "../src/withdrawals.js";

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
  resolve({ next_block: 101, data: [] }); await monitor.refresh();
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
