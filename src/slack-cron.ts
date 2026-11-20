import { WithdrawalStore } from "./withdrawal-store.js";
import { WithdrawalMonitor } from "./withdrawals.js";
import { readBalance, makeClient } from "./chain.js";
import { loadConfig } from "./config.js";
import { SnapshotStore } from "./database.js";
import { safeErrorMessage } from "./errors.js";
import { SlackAlerter } from "./slack-alerts.js";
import { buildLiquiditySnapshot } from "./status.js";
import { readCirculatingSupply } from "./supply.js";

async function main(): Promise<void> {
  const config = loadConfig();
  if (!config.slackWebhookUrl) throw new Error("SLACK_WEBHOOK_URL is required by the Slack alert cron");
  const store = SnapshotStore.fromEnvironment();
  if (!store) throw new Error("DATABASE_URL is required by the Slack alert cron");

  try {
    const [reading, supply] = await Promise.all([readBalance(makeClient(config), config), readCirculatingSupply()]);
    const snapshot = buildLiquiditySnapshot(reading, supply);
    // Record independently of alert delivery and of indexer catch-up duration.
    const flows = WithdrawalStore.fromEnvironment()!;
    try {
      const flowMonitor = new WithdrawalMonitor(makeClient(config), config, flows);
      const [withdrawals, depositors] = await Promise.all([flowMonitor.result("1d"), flowMonitor.result("1d", "depositors")]);
      await store.saveIntraday({ observedAt: reading.checkedAt, reserve: snapshot, withdrawals, depositors });
    } catch (error) {
      console.error(JSON.stringify({ event: "intraday_snapshot_failed", message: safeErrorMessage(error) }));
    } finally { await flows.close(); }
    const alerter = new SlackAlerter({
      webhookUrl: config.slackWebhookUrl,
      ...(process.env.SLACK_SFF_MENTION ? { sffMention: process.env.SLACK_SFF_MENTION } : {}),
    }, store);
    await alerter.check(snapshot);
    console.log(JSON.stringify({ event: "slack_cron_complete", balanceUsdc: snapshot.totalBalanceUsdc, circulatingSupply: snapshot.circulatingSupply, supplyCheckedAt: snapshot.supplyCheckedAt, blockNumber: snapshot.blockNumber }));
  } finally {
    await store.close();
  }
}

main().catch((error) => {
  console.error(JSON.stringify({ event: "slack_cron_failed", message: safeErrorMessage(error) }));
  process.exitCode = 1;
});
