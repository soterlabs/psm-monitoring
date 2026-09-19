import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildSnapshot, determineLevel } from "../src/status.js";

const limit = 4_000_000_000_000_000n;

describe("determineLevel", () => {
  it("uses exact warning, critical, and exceeded boundaries", () => {
    assert.equal(determineLevel(3_599_999_999_999_999n, limit, 90, 95), "ok");
    assert.equal(determineLevel(3_600_000_000_000_000n, limit, 90, 95), "warning");
    assert.equal(determineLevel(3_800_000_000_000_000n, limit, 90, 95), "critical");
    assert.equal(determineLevel(limit, limit, 90, 95), "exceeded");
  });

  it("does not lose precision for large token balances", () => {
    assert.equal(determineLevel(limit + 1n, limit, 90, 95), "exceeded");
  });
});

describe("buildSnapshot", () => {
  it("aggregates and formats the reading", () => {
    const snapshot = buildSnapshot({
      checkedAt: "2026-09-19T00:00:00.000Z",
      blockNumber: "123",
      blockTimestamp: "2026-09-19T00:00:00.000Z",
      chainId: 1,
      psmAddress: "0xpsm",
      pocketAddress: "0xpocket",
      tokenAddress: "0xusdc",
      pocketBalanceRaw: 4_000_000_000_000_001n,
      psmBalanceRaw: 2n,
      totalBalanceRaw: 4_000_000_000_000_003n,
    }, limit, 90, 95);
    assert.equal(snapshot.status, "exceeded");
    assert.equal(snapshot.totalBalanceUsdc, "4000000000.000003");
    assert.equal(snapshot.remainingUsdc, "-0.000003");
    assert.equal(snapshot.utilizationPercent, 100);
  });
});
