import assert from "node:assert/strict";
import { it } from "node:test";
import { dashboardPeriods, renderDashboard } from "../src/dashboard.js";
import { DirectExposureMonitor } from "../src/direct-exposure.js";
import type { SnapshotStore } from "../src/database.js";

it("selects each configurable default on all four cards with one selected option per card", () => {
  for (const period of dashboardPeriods) {
    const html = renderDashboard(period);
    const selects = [...html.matchAll(/<select id="(?:reserveRange|withdrawalRange|depositorRange|exposureRange)"[\s\S]*?<\/select>/g)];
    assert.equal(selects.length, 4);
    for (const [select] of selects) {
      assert.equal((select.match(/ selected>/g) ?? []).length, 1);
      assert.ok(select.includes(`<option value="${period}" selected>`));
    }
    for (const [loader, id] of [["loadReserveHistory", "reserveRange"], ["loadWithdrawals", "withdrawalRange"], ["loadDeposits", "depositorRange"], ["loadExposure", "exposureRange"]]) {
      assert.ok(html.includes(`${loader}($('${id}').value)`));
    }
  }
});

it("uses the environment setting and defaults to Last 24h when unset", () => {
  const prior = process.env.DASHBOARD_DEFAULT_PERIOD;
  try {
    delete process.env.DASHBOARD_DEFAULT_PERIOD;
    assert.equal((renderDashboard().match(/value="24h" selected/g) ?? []).length, 4);
    process.env.DASHBOARD_DEFAULT_PERIOD = "7d";
    assert.equal((renderDashboard().match(/value="7d" selected/g) ?? []).length, 4);
    assert.throws(() => renderDashboard("invalid"), /DASHBOARD_DEFAULT_PERIOD/);
  } finally {
    if (prior === undefined) delete process.env.DASHBOARD_DEFAULT_PERIOD;
    else process.env.DASHBOARD_DEFAULT_PERIOD = prior;
  }
});

it("supports the shared default periods for refill capacity without fabricating intraday estimates", async () => {
  const store = { async loadExposure() { return { points: [{ date: "2026-11-20", totalUsd: 123, venues: {} }], generatedAt: "2026-11-20T12:00:00Z" }; } } as unknown as SnapshotStore;
  const monitor = new DirectExposureMonitor(store);
  await monitor.load(new Date("2026-11-20T12:00:00Z"), false);
  assert.equal(monitor.lastError, undefined);
  for (const period of dashboardPeriods) assert.ok(monitor.series.get(period)?.points.length);
  const latest = monitor.series.get("24h")!;
  assert.equal(latest.points.length, 1);
  assert.equal(latest.interval, "daily");
  assert.equal(latest.points[0]?.date, latest.asOf);
  const halfYear = monitor.series.get("180d")!;
  const cutoff = Date.parse(`${halfYear.asOf}T00:00:00Z`) - 179 * 86_400_000;
  assert.ok(halfYear.points.every(point => Date.parse(`${point.date}T00:00:00Z`) >= cutoff));
});
