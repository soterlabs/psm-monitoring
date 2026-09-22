import assert from "node:assert/strict";
import test from "node:test";
import {
  addBasinJtrsy,
  mergeHistoricalExposure,
  parseBasinJtrsyHistory,
  parsePrimeResult,
} from "../src/direct-exposure.js";
import { sdeBaselinePoints } from "../src/sde-baseline.js";

test("parsePrimeResult separates named venues from the PSM3 residual", () => {
  const result = parsePrimeResult("spark", {
    sde_daily_breakdown: [
      { venue_id: "S24", daily: [{ block_date: "2026-09-01", cum_value: "20" }] },
      { venue_id: "S62", daily: [{ block_date: "2026-09-01", cum_value: "30" }] },
    ],
    sky_revenue_daily: [{ date: "2026-09-01", sde_av: "65" }],
  });
  assert.deepEqual(result.get("2026-09-01"), {
    "spark:S24": 20,
    "spark:S62": 30,
    "spark:psm3": 15,
  });
});

test("parsePrimeResult excludes a venue removed from canonical SDE scope without treating it as PSM3", () => {
  const result = parsePrimeResult("spark", {
    sde_daily_breakdown: [
      { venue_id: "S61", daily: [{ block_date: "2026-08-31", cum_value: "40" }] },
      { venue_id: "S62", daily: [{ block_date: "2026-08-31", cum_value: "10" }] },
    ],
    sky_revenue_daily: [{ date: "2026-08-31", sde_av: "55" }],
  });
  assert.deepEqual(result.get("2026-08-31"), {
    "spark:S62": 10,
    "spark:psm3": 5,
  });
});

test("parseBasinJtrsyHistory reads dated Basin asset values", () => {
  assert.deepEqual(
    [...parseBasinJtrsyHistory({
      data: [
        { date: "2026-09-17", assets: "50150735.448587153026248652" },
        { date: "2026-09-16", assets: "42500139.126589995942488851" },
      ],
    })],
    [
      ["2026-09-17", 50_150_735.44858715],
      ["2026-09-16", 42_500_139.12659],
    ],
  );
});

test("addBasinJtrsy sums Basin into the existing JTRSY line and total", () => {
  const original = [{
    date: "2026-09-17",
    totalUsd: 500,
    venues: { "grove:E9": 300, "spark:psm3": 200 },
  }];
  const result = addBasinJtrsy(original, new Map([["2026-09-17", 50]]));

  assert.deepEqual(result, [{
    date: "2026-09-17",
    totalUsd: 550,
    venues: { "grove:E9": 350, "spark:psm3": 200 },
  }]);
  assert.deepEqual(original[0]?.venues, { "grove:E9": 300, "spark:psm3": 200 });
});

test("reviewed SDE history is daily from January 2025 and applies Atlas scope dates", () => {
  assert.equal(sdeBaselinePoints.length, 608);
  assert.equal(sdeBaselinePoints[0]?.date, "2025-01-01");
  assert.equal(sdeBaselinePoints.at(-1)?.date, "2026-08-31");
  assert.equal(sdeBaselinePoints.find((point) => point.date === "2025-10-22")?.totalUsd, 0);
  assert.ok((sdeBaselinePoints.find((point) => point.date === "2025-10-23")?.venues["grove:E8"] ?? 0) > 0);
  assert.ok((sdeBaselinePoints.find((point) => point.date === "2026-03-11")?.venues["grove:E8"] ?? 0) > 0);
  assert.equal(sdeBaselinePoints.find((point) => point.date === "2026-03-12")?.venues["grove:E8"], undefined);
  assert.equal(sdeBaselinePoints.find((point) => point.date === "2026-05-25")?.venues["spark:S62"], 0);
  assert.ok((sdeBaselinePoints.find((point) => point.date === "2026-05-26")?.venues["spark:S62"] ?? 0) > 0);
  assert.ok((sdeBaselinePoints.find((point) => point.date === "2026-06-24")?.venues["spark:S24"] ?? 0) > 0);
  assert.equal(sdeBaselinePoints.find((point) => point.date === "2026-06-25")?.venues["spark:S24"], undefined);
});

test("reviewed history cannot be overwritten but live data extends its cutoff", () => {
  const historical = sdeBaselinePoints.find((point) => point.date === "2025-10-23");
  assert.ok(historical);
  const merged = mergeHistoricalExposure([
    { date: "2025-10-23", totalUsd: 1, venues: { "grove:E8": 1 } },
    { date: "2026-09-01", totalUsd: 2, venues: { "grove:E9": 2 } },
  ]);
  assert.deepEqual(merged.find((point) => point.date === "2025-10-23"), historical);
  assert.deepEqual(merged.at(-1), { date: "2026-09-01", totalUsd: 2, venues: { "grove:E9": 2 } });
});
