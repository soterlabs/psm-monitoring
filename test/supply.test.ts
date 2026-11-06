import assert from "node:assert/strict";
import { it } from "node:test";
import { readCirculatingSupply } from "../src/supply.js";

const response = (data: object) => (async () => Response.json({ success: true, data })) as typeof fetch;
it("uses combined circulating USDS and DAI rather than total issuance or savings TVL", async () => {
  const value = await readCirculatingSupply(response({ total_circulating: "8700000000.123456789012345678", circulating_usds: "4800000000", circulating_dai: "3900000000.123456789012345678", total_supply: "12000000000" }));
  assert.equal(value.circulatingSupply, "8700000000.123456789012345678");
  assert.ok(Number.isFinite(Date.parse(value.supplyCheckedAt)));
});
it("fails closed on unavailable, missing, zero or inconsistent supply", async () => {
  await assert.rejects(readCirculatingSupply((async () => new Response("unavailable", { status: 503 })) as typeof fetch), /503/);
  await assert.rejects(readCirculatingSupply(response({ total_supply: "8700000000" })), /missing/);
  await assert.rejects(readCirculatingSupply(response({ total_circulating: "0", circulating_usds: "0", circulating_dai: "0" })), /positive/);
  await assert.rejects(readCirculatingSupply(response({ total_circulating: "100", circulating_usds: "20", circulating_dai: "30" })), /reconcile/);
});
