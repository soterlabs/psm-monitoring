import assert from "node:assert/strict";
import { it } from "node:test";
import { WithdrawalRateLimitError, withdrawalRetryAt } from "../src/withdrawal-rate-limit.js";
import { fetchWithdrawalPage } from "../src/withdrawals.js";

it("honors Retry-After seconds and HTTP dates, and backs off exponentially without a valid header", () => {
  const now = Date.parse("2026-11-06T12:00:00Z");
  assert.equal(withdrawalRetryAt("600", 1, now), "2026-11-06T12:10:00.000Z");
  assert.equal(withdrawalRetryAt("Fri, 06 Nov 2026 13:00:00 GMT", 1, now), "2026-11-06T13:00:00.000Z");
  assert.equal(withdrawalRetryAt("0", 1, now), "2026-11-06T12:01:00.000Z");
  assert.equal(withdrawalRetryAt(null, 4, now), "2026-11-06T12:08:00.000Z");
  assert.equal(withdrawalRetryAt("invalid", 20, now), "2026-11-06T12:30:00.000Z");
  assert.equal(withdrawalRetryAt("9999999999999999999", 1, now), "2026-11-06T12:01:00.000Z");
});

it("surfaces 429 and Retry-After after one request instead of immediately retrying", async () => {
  const old = process.env.ENVIO_API_TOKEN;
  process.env.ENVIO_API_TOKEN = "test-only-token";
  let requests = 0;
  try {
    await assert.rejects(fetchWithdrawalPage("0x1", 1, 2, "0x2", "0x3", (async () => {
      requests++;
      return new Response("rate limited", { status: 429, headers: { "retry-after": "600" } });
    }) as typeof fetch), (error: unknown) => error instanceof WithdrawalRateLimitError && error.retryAfter === "600");
    assert.equal(requests, 1);
  } finally { if (old === undefined) delete process.env.ENVIO_API_TOKEN; else process.env.ENVIO_API_TOKEN = old; }
});
