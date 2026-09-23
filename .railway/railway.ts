import { defineRailway, fn, github, postgres, preserve, project, service } from "railway/iac";

export default defineRailway(() => {
  const snapshots = postgres("snapshot-database", { region: "us-west2" });
  const psmMonitoring = service("psm-monitoring", {
    source: github("soterlabs/psm-monitoring"),
    replicas: { "us-west2": 1 },
    env: {
      ETH_RPC: preserve(),
      BASE_RPC: preserve(),
      ARBITRUM_RPC: preserve(),
      OPTIMISM_RPC: preserve(),
      UNICHAIN_RPC: preserve(),
      SLACK_WEBHOOK_URL: preserve(),
      DATABASE_URL: snapshots.env.DATABASE_URL,
    },
    healthcheck: "/healthz",
    healthcheckTimeout: 30,
  });

  const dailySnapshots = fn("daily-snapshots", {
    source: github("soterlabs/psm-monitoring"),
    env: {
      ETH_RPC: psmMonitoring.env.ETH_RPC,
      DATABASE_URL: snapshots.env.DATABASE_URL,
    },
    start: "npm run cron",
    deploy: {
      cronSchedule: "15 2 * * *",
      restartPolicyType: "NEVER",
    },
  });

  return project("psm-monitoring", {
    resources: [snapshots, psmMonitoring, dailySnapshots],
  });
});
