import assert from "node:assert/strict";
import { it } from "node:test";
import { reserveChartAxis } from "../src/chart-axis.js";
import { dashboardHtml } from "../src/dashboard.js";
import { runInNewContext } from "node:vm";

it("uses round 100M ticks around a narrow multibillion reserve range", () => {
  assert.deepEqual(reserveChartAxis(2.607e9, 2.68e9), { lo: 2.5e9, hi: 2.7e9, ticks: [2.5e9, 2.6e9, 2.7e9] });
});

it("keeps balances and targets inside the axis across wide and flat ranges", () => {
  for (const [min, max] of [[2.5e9, 4.4e9], [2.6e9, 2.6e9], [0, 0], [80e6, 100e6]]) {
    const axis = reserveChartAxis(min!, max!);
    assert.ok(axis.lo <= min! && axis.hi >= max! && axis.lo >= 0);
    assert.ok(axis.hi > axis.lo && axis.ticks.length >= 2 && axis.ticks.length <= 8);
  }
});

it("draws round labels using the embedded dashboard script at mobile and desktop widths", () => {
  const axisStart = dashboardHtml.indexOf("const reserveChartAxis="), axisEnd = dashboardHtml.indexOf("\nconst $=", axisStart);
  const drawStart = dashboardHtml.indexOf("function drawReserve(){"), drawEnd = dashboardHtml.indexOf("async function loadReserveHistory", drawStart);
  assert.ok(axisStart > 0 && axisEnd > axisStart && drawStart > 0 && drawEnd > drawStart);
  for (const width of [390, 1280]) {
    const labels: string[] = [];
    const points = [2.607e9, 2.64e9, 2.68e9].map((balance, i) => ({ timestamp: `2026-11-0${7 + i}T12:00:00Z`, balanceUsdc: String(balance), targetUsdc: "2610000000", utilizationPercent: 100 }));
    const canvas = new Proxy({ fillText: (text: string) => labels.push(text), measureText: () => ({ width: 40 }) }, { get: (target, key) => Reflect.get(target, key) ?? (() => {}) });
    runInNewContext(dashboardHtml.slice(axisStart, axisEnd) + dashboardHtml.slice(drawStart, drawEnd) + "drawReserve();", {
      rc: { getBoundingClientRect: () => ({ width, height: 310 }) }, rctx: canvas,
      devicePixelRatio: 1, reservePoints: points, reserveTargetPoints: points, reservePlot: null,
      compact: (value: number) => new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 2 }).format(value),
      chartColor: () => "#000", colorFor: () => "#000",
    });
    assert.deepEqual(labels.filter(label => label.endsWith("B")), ["2.5B", "2.6B", "2.7B"]);
  }
});
