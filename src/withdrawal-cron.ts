import { makeClient } from "./chain.js";
import { loadConfig } from "./config.js";
import { safeErrorMessage } from "./errors.js";
import { WithdrawalStore } from "./withdrawal-store.js";
import { WithdrawalMonitor } from "./withdrawals.js";

const config = loadConfig();
const store = WithdrawalStore.fromEnvironment();
if (!store) throw new Error("DATABASE_URL is required to persist withdrawal history");
try {
  const monitor = new WithdrawalMonitor(makeClient(config), config, store);
  do {
    await monitor.refresh();
    const result = await monitor.result("180d");
    console.log(JSON.stringify({ event: "withdrawal_index_progress", indexedPercent: result.indexedPercent, asOf: result.asOf }));
    if (result.complete) break;
    await new Promise(resolve => setTimeout(resolve, 1000));
  } while (true);
} catch (error) {
  console.error(JSON.stringify({ event: "withdrawal_index_failed", message: safeErrorMessage(error) }));
  process.exitCode = 1;
} finally { await store.close(); }
