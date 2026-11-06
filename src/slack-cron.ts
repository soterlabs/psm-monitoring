import { readBalance, makeClient } from "./chain.js";
import { loadConfig } from "./config.js";
import { SnapshotStore } from "./database.js";
import { safeErrorMessage } from "./errors.js";
import { SlackAlerter } from "./slack-alerts.js";
import { buildSnapshot } from "./status.js";
import { readCirculatingSupply } from "./supply.js";

async function main(): Promise<void> {
  const config = loadConfig();
  if (!config.slackWebhookUrl) throw new Error("SLACK_WEBHOOK_URL is required by the Slack alert cron");
  const store = SnapshotStore.fromEnvironment();
  if (!store) throw new Error("DATABASE_URL is required by the Slack alert cron");

  try {
    const [reading, supply] = await Promise.all([readBalance(makeClient(config), config), readCirculatingSupply()]);
    const snapshot = { ...buildSnapshot(reading, config.limitRaw, config.yellowPercent, config.orangePercent), ...supply };
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
