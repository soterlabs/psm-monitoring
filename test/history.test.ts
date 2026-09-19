import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { historyTargets } from "../src/history.js";

describe("historyTargets", () => {
  const now = new Date("2026-09-19T12:00:00.000Z");

  it("returns 90 daily targets ending at the latest timestamp", () => {
    const targets = historyTargets("90d", now);
    assert.equal(targets.length, 90);
    assert.equal(targets.at(-1)?.toISOString(), now.toISOString());
    assert.equal(targets[0]?.toISOString(), "2026-06-22T12:00:00.000Z");
  });

  it("returns monthly targets from January 2025 plus the latest point", () => {
    const targets = historyTargets("monthly", now);
    assert.equal(targets.length, 22);
    assert.equal(targets[0]?.toISOString(), "2025-01-01T00:00:00.000Z");
    assert.equal(targets.at(-1)?.toISOString(), now.toISOString());
  });
});
