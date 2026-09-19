import { defineRailway, github, preserve, project, service } from "railway/iac";

export default defineRailway(() => {
  const psmMonitoring = service("psm-monitoring", {
    source: github("soterlabs/psm-monitoring"),
    replicas: { "us-west2": 1 },
    env: {
      ETH_RPC: preserve(),
      BASE_RPC: preserve(),
      ARBITRUM_RPC: preserve(),
      OPTIMISM_RPC: preserve(),
      UNICHAIN_RPC: preserve(),
    },
    healthcheck: "/healthz",
    healthcheckTimeout: 30,
  });

  return project("psm-monitoring", {
    resources: [psmMonitoring],
  });
});
