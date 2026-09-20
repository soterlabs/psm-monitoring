import { createServer, type ServerResponse } from "node:http";
import { getAddress } from "viem";
import { loadConfig } from "./config.js";
import { makeClient } from "./chain.js";
import { dashboardHtml } from "./dashboard.js";
import { DirectExposureMonitor } from "./direct-exposure.js";
import { Monitor } from "./monitor.js";
import { HistoryMonitor } from "./history.js";
import { Psm3Monitor } from "./psm3.js";

const config = loadConfig();
const client = makeClient(config);
const monitor = new Monitor(client, config);
const history = new HistoryMonitor(client, config);
const directExposure = new DirectExposureMonitor();
const psm3 = new Psm3Monitor();
let historyWaitTimer: NodeJS.Timeout | undefined;

function send(response: ServerResponse, status: number, contentType: string, body: string): void {
  response.writeHead(status, {
    "content-type": contentType,
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
    "referrer-policy": "no-referrer",
  });
  response.end(body);
}

function metrics(): string {
  const snapshot = monitor.snapshot;
  const fresh = monitor.isFresh() ? 1 : 0;
  const lines = [
    "# HELP psm_monitor_data_fresh Whether the most recent reading is fresh.",
    "# TYPE psm_monitor_data_fresh gauge",
    `psm_monitor_data_fresh ${fresh}`,
    "# HELP psm_monitor_rpc_error Whether the latest poll failed.",
    "# TYPE psm_monitor_rpc_error gauge",
    `psm_monitor_rpc_error ${monitor.lastError ? 1 : 0}`,
  ];
  if (snapshot) {
    lines.push(
      "# HELP psm_usdc_balance USDC held by the LitePSM and its pocket.",
      "# TYPE psm_usdc_balance gauge",
      `psm_usdc_balance ${snapshot.totalBalanceUsdc}`,
      "# HELP psm_usdc_limit Configured USDC operational limit.",
      "# TYPE psm_usdc_limit gauge",
      `psm_usdc_limit ${snapshot.limitUsdc}`,
      "# HELP psm_usdc_utilization_ratio Balance divided by configured limit.",
      "# TYPE psm_usdc_utilization_ratio gauge",
      `psm_usdc_utilization_ratio ${snapshot.utilizationPercent / 100}`,
      "# HELP psm_monitor_last_success_timestamp_seconds Unix time of the latest successful poll.",
      "# TYPE psm_monitor_last_success_timestamp_seconds gauge",
      `psm_monitor_last_success_timestamp_seconds ${Date.parse(snapshot.checkedAt) / 1_000}`,
    );
  }
  const exposure = directExposure.series.get("90d");
  const latestExposure = exposure?.points.at(-1);
  lines.push(
    "# HELP sky_direct_exposure_data_available Whether direct-exposure data is available.",
    "# TYPE sky_direct_exposure_data_available gauge",
    `sky_direct_exposure_data_available ${latestExposure ? 1 : 0}`,
  );
  if (latestExposure) {
    lines.push(
      "# HELP sky_direct_exposure_usdc_equivalent Estimated SDE refill capacity in USD (USDC-equivalent).",
      "# TYPE sky_direct_exposure_usdc_equivalent gauge",
      `sky_direct_exposure_usdc_equivalent ${latestExposure.totalUsd}`,
      "# HELP sky_direct_exposure_as_of_timestamp_seconds Date represented by the latest SDE estimate.",
      "# TYPE sky_direct_exposure_as_of_timestamp_seconds gauge",
      `sky_direct_exposure_as_of_timestamp_seconds ${Date.parse(`${latestExposure.date}T00:00:00Z`) / 1_000}`,
    );
  }
  if (psm3.snapshot) {
    lines.push(
      "# HELP sky_psm3_usdc_reserve USDC held directly by an L2 PSM3 contract.",
      "# TYPE sky_psm3_usdc_reserve gauge",
      ...psm3.snapshot.chains.map((chain) => `sky_psm3_usdc_reserve{chain="${chain.chain.toLowerCase()}"} ${chain.reserveUsdc}`),
      "# HELP sky_psm3_usdc_reserve_total Total USDC held by the four monitored L2 PSM3 contracts.",
      "# TYPE sky_psm3_usdc_reserve_total gauge",
      `sky_psm3_usdc_reserve_total ${psm3.snapshot.totalReserveUsdc}`,
    );
  }
  return `${lines.join("\n")}\n`;
}

const server = createServer((request, response) => {
  const url = new URL(request.url ?? "/", "http://localhost");
  const path = url.pathname;
  if (request.method !== "GET") return send(response, 405, "text/plain; charset=utf-8", "Method not allowed\n");
  if (path === "/") return send(response, 200, "text/html; charset=utf-8", dashboardHtml);
  if (path === "/direct-exposure") return send(response, 200, "text/html; charset=utf-8", dashboardHtml);
  if (path === "/healthz") return send(response, 200, "application/json; charset=utf-8", '{"status":"alive"}\n');
  if (path === "/readyz") {
    const fresh = monitor.isFresh();
    return send(response, fresh ? 200 : 503, "application/json; charset=utf-8", `${JSON.stringify({ status: fresh ? "ready" : "not_ready" })}\n`);
  }
  if (path === "/api/status") {
    const fresh = monitor.isFresh();
    return send(response, monitor.snapshot ? 200 : 503, "application/json; charset=utf-8", `${JSON.stringify({ fresh, snapshot: monitor.snapshot ?? null, error: monitor.lastError ?? null })}\n`);
  }
  if (path === "/api/history") {
    const requested = url.searchParams.get("range");
    const range = requested === "7d" || requested === "30d" || requested === "180d" || requested === "monthly" ? requested : "90d";
    return send(response, 200, "application/json; charset=utf-8", `${JSON.stringify({
      loading: history.loading,
      series: history.series.get(range) ?? null,
      error: history.lastError ?? null,
    })}\n`);
  }
  if (path === "/api/direct-exposure") {
    const requested = url.searchParams.get("range");
    const range = requested === "7d" || requested === "30d" || requested === "ytd" || requested === "monthly" ? requested : "90d";
    return send(response, directExposure.series.has(range) ? 200 : 503, "application/json; charset=utf-8", `${JSON.stringify({
      loading: directExposure.loading,
      series: directExposure.series.get(range) ?? null,
      error: directExposure.lastError ?? null,
    })}\n`);
  }
  if (path === "/api/psm3") {
    return send(response, psm3.snapshot ? 200 : 503, "application/json; charset=utf-8", `${JSON.stringify({
      loading: psm3.loading,
      snapshot: psm3.snapshot ?? null,
      error: psm3.lastError ?? null,
    })}\n`);
  }
  if (path === "/metrics") return send(response, 200, "text/plain; version=0.0.4; charset=utf-8", metrics());
  return send(response, 404, "text/plain; charset=utf-8", "Not found\n");
});

await monitor.poll();
monitor.start();
directExposure.start();
psm3.start();
server.listen(config.port, "0.0.0.0", () => {
  console.log(JSON.stringify({ event: "server_started", port: config.port }));
  const startHistory = (): void => {
    if (monitor.snapshot) {
      history.start(getAddress(monitor.snapshot.pocketAddress));
      if (historyWaitTimer) clearInterval(historyWaitTimer);
    }
  };
  startHistory();
  if (!monitor.snapshot) {
    historyWaitTimer = setInterval(startHistory, 10_000);
    historyWaitTimer.unref();
  }
});

function shutdown(signal: string): void {
  console.log(JSON.stringify({ event: "shutdown", signal }));
  monitor.stop();
  history.stop();
  directExposure.stop();
  psm3.stop();
  if (historyWaitTimer) clearInterval(historyWaitTimer);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
