import { defineRailway, preserve, project, service } from "railway/iac";

export default defineRailway(() => {
  const psmMonitoring = service("psm-monitoring", {
    replicas: { "us-west2": 1 },
    env: { ETH_RPC: preserve() },
    healthcheck: "/healthz",
    healthcheckTimeout: 30,
  });

  return project("psm-monitoring", {
    resources: [psmMonitoring],
  });
});
