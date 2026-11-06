import assert from "node:assert/strict";
import { it } from "node:test";
import type { PublicClient } from "viem";
import { loadConfig } from "../src/config.js";
import { Monitor } from "../src/monitor.js";

it("marks the dashboard stale on supply failure and never substitutes the configured absolute target", async () => {
  const previous = process.env.ETH_RPC; process.env.ETH_RPC = "https://example.com";
  let cfg;
  try { const { alertWebhookUrl, ...rest } = loadConfig(); cfg = rest; }
  finally { if (previous === undefined) delete process.env.ETH_RPC; else process.env.ETH_RPC = previous; }
  let failed = false;
  const monitor = new Monitor({} as PublicClient, cfg,
    async () => { if (failed) throw new Error("Supply unavailable"); return { circulatingSupply: "8700000000", supplyCheckedAt: new Date().toISOString() }; },
    async () => ({ checkedAt: new Date().toISOString(), blockTimestamp: new Date().toISOString(), blockNumber: "123", chainId: 1,
      psmAddress: "0xpsm", pocketAddress: "0xpocket", tokenAddress: "0xusdc", pocketBalanceRaw: 2700000000000000n,
      psmBalanceRaw: 0n, totalBalanceRaw: 2700000000000000n }));
  await monitor.poll();
  assert.equal(monitor.snapshot?.limitUsdc, "2610000000"); assert.equal(monitor.isFresh(), true);
  failed = true; await monitor.poll();
  assert.equal(monitor.isFresh(), false); assert.equal(monitor.snapshot?.limitUsdc, "2610000000");
  assert.equal(monitor.lastError?.message, "Supply unavailable");
});
