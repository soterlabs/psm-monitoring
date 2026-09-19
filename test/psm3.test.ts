import assert from "node:assert/strict";
import test from "node:test";
import { summarizePsm3, type Psm3ChainBalance } from "../src/psm3.js";

test("summarizePsm3 totals reserves and Spark's proportional claims", () => {
  const base = { chainId: 1, blockNumber: "1", psmAddress: "0x0", sparkOwnershipPercent: 99 };
  const chains: Psm3ChainBalance[] = [
    { ...base, chain: "A", reserveUsdc: 10, sparkClaimUsdc: 9.9 },
    { ...base, chain: "B", reserveUsdc: 20, sparkClaimUsdc: 19.8 },
  ];
  const result = summarizePsm3(chains);
  assert.equal(result.totalReserveUsdc, 30);
  assert.ok(Math.abs(result.totalSparkClaimUsdc - 29.7) < 1e-9);
});
