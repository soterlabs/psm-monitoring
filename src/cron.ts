import { getAddress } from "viem";
import { makeClient, readBalance } from "./chain.js";
import { loadConfig } from "./config.js";
import { SnapshotStore } from "./database.js";
import { loadDirectExposurePoints } from "./direct-exposure.js";
import { safeErrorMessage } from "./errors.js";
import { HistoryMonitor } from "./history.js";

async function run(): Promise<void> {
  const store = SnapshotStore.fromEnvironment();
  if (!store) throw new Error("DATABASE_URL is required for the daily snapshot worker");

  try {
    await store.initialize();
    const config = loadConfig();
    const client = makeClient(config);
    const reading = await readBalance(client, config);
    const history = new HistoryMonitor(client, config);
    await history.load(getAddress(reading.pocketAddress));
    const daily = history.series.get("180d")?.points;
    const monthly = history.series.get("monthly")?.points;
    if (!daily?.length || !monthly?.length) {
      throw new Error(history.lastError?.message ?? "Ethereum history generation returned no points");
    }

    const exposure = await loadDirectExposurePoints();
    if (!exposure.length) throw new Error("Direct-exposure generation returned no points");

    await store.saveHistory(daily, "daily");
    await store.saveHistory(monthly.slice(0, -1), "monthly");
    await store.saveExposure(exposure);
    console.log(JSON.stringify({
      event: "daily_snapshots_saved",
      at: new Date().toISOString(),
      psmDailyPoints: daily.length,
      psmMonthlyPoints: monthly.length - 1,
      directExposurePoints: exposure.length,
      directExposureAsOf: exposure.at(-1)?.date,
    }));
  } finally {
    await store.close();
  }
}

try {
  await run();
} catch (error) {
  console.error(JSON.stringify({ event: "daily_snapshots_failed", message: safeErrorMessage(error), at: new Date().toISOString() }));
  process.exitCode = 1;
}
