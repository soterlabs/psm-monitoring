import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildSnapshot, buildLiquiditySnapshot, determineLevel } from "../src/status.js";
import { parseUnits } from "viem";

const limit = 4_000_000_000_000_000n;

describe("determineLevel", () => {
  it("uses low, orange, yellow, and healthy boundaries", () => {
    assert.equal(determineLevel(3_599_999_999_999_999n, limit, 95, 90), "low");
    assert.equal(determineLevel(3_600_000_000_000_000n, limit, 95, 90), "critical");
    assert.equal(determineLevel(3_800_000_000_000_000n, limit, 95, 90), "warning");
    assert.equal(determineLevel(limit, limit, 95, 90), "healthy");
  });

  it("does not lose precision for large token balances", () => {
    assert.equal(determineLevel(limit + 1n, limit, 95, 90), "healthy");
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
    }, limit, 95, 90);
    assert.equal(snapshot.status, "healthy");
    assert.equal(snapshot.totalBalanceUsdc, "4000000000.000003");
    assert.equal(snapshot.remainingUsdc, "-0.000003");
    assert.equal(snapshot.utilizationPercent, 100);
  });
});

describe("30% circulating supply target", () => {
  const reading = (balance: string) => ({ checkedAt: "2026-11-06T20:00:00Z", blockNumber: "123", blockTimestamp: "2026-11-06T20:00:00Z",
    chainId: 1, psmAddress: "0xpsm", pocketAddress: "0xpocket", tokenAddress: "0xusdc", pocketBalanceRaw: parseUnits(balance, 6),
    psmBalanceRaw: 0n, totalBalanceRaw: parseUnits(balance, 6) });
  const supply = (circulatingSupply: string) => ({ circulatingSupply, supplyCheckedAt: "2026-11-06T20:00:01Z" });
  it("updates target, status, ratio and headroom when circulating supply changes", () => {
    const first = buildLiquiditySnapshot(reading("2700000000"), supply("8700000000"));
    assert.equal(first.limitUsdc, "2610000000"); assert.equal(first.remainingUsdc, "-90000000");
    assert.equal(first.status, "healthy"); assert.equal(first.reserveRatioPercent, 31.034482);
    const next = buildLiquiditySnapshot(reading("2700000000"), supply("10000000000"));
    assert.equal(next.limitUsdc, "3000000000"); assert.equal(next.remainingUsdc, "300000000");
    assert.equal(next.status, "critical"); assert.equal(next.reserveRatioPercent, 27);
  });
  it("uses the same exact threshold bands as alerts, including fractional supply", () => {
    for (const [balance, band] of [["3000000000", "healthy"], ["2999999999.999999", "below_30"], ["2799999999.999999", "below_28"],
      ["2499999999.999999", "below_25"], ["1999999999.999999", "below_20"]] as const) {
      assert.equal(buildLiquiditySnapshot(reading(balance), supply("10000000000")).reserveBand, band);
    }
    const fractional = buildLiquiditySnapshot(reading("3000000000"), supply("10000000000.000000000000000001"));
    assert.equal(fractional.limitUsdc, "3000000000.000001"); assert.equal(fractional.status, "warning");
    assert.equal(fractional.remainingUsdc, "0.000001");
  });
});
