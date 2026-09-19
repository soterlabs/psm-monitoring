import { getAddress, isAddress, parseUnits, type Address } from "viem";

export interface Config {
  rpcUrl: string;
  port: number;
  psmAddress: Address;
  usdcAddress: Address;
  limitRaw: bigint;
  limitUsdc: string;
  warningPercent: number;
  criticalPercent: number;
  pollIntervalMs: number;
  staleAfterMs: number;
  alertReminderMs: number;
  alertWebhookUrl?: string;
}

function numberFromEnv(name: string, fallback: number, minimum: number): number {
  const raw = process.env[name];
  const value = raw === undefined ? fallback : Number(raw);
  if (!Number.isFinite(value) || value < minimum) {
    throw new Error(`${name} must be a number greater than or equal to ${minimum}`);
  }
  return value;
}

function addressFromEnv(name: string, fallback: string): Address {
  const value = process.env[name] ?? fallback;
  if (!isAddress(value)) throw new Error(`${name} must be a valid Ethereum address`);
  return getAddress(value);
}

export function loadConfig(): Config {
  const rpcUrl = process.env.ETH_RPC;
  if (!rpcUrl) throw new Error("ETH_RPC is required");
  try {
    new URL(rpcUrl);
  } catch {
    throw new Error("ETH_RPC must be a valid URL");
  }

  const warningPercent = numberFromEnv("WARNING_PERCENT", 90, 0);
  const criticalPercent = numberFromEnv("CRITICAL_PERCENT", 95, 0);
  if (warningPercent >= criticalPercent || criticalPercent >= 100) {
    throw new Error("Thresholds must satisfy WARNING_PERCENT < CRITICAL_PERCENT < 100");
  }

  const limitUsdc = process.env.LIMIT_USDC ?? "4000000000";
  let limitRaw: bigint;
  try {
    limitRaw = parseUnits(limitUsdc, 6);
  } catch {
    throw new Error("LIMIT_USDC must be a positive decimal with at most 6 decimal places");
  }
  if (limitRaw <= 0n) throw new Error("LIMIT_USDC must be positive");

  const alertWebhookUrl = process.env.ALERT_WEBHOOK_URL || undefined;
  if (alertWebhookUrl) {
    try {
      new URL(alertWebhookUrl);
    } catch {
      throw new Error("ALERT_WEBHOOK_URL must be a valid URL");
    }
  }

  return {
    rpcUrl,
    port: numberFromEnv("PORT", 3000, 1),
    psmAddress: addressFromEnv("PSM_ADDRESS", "0xf6e72Db5454dd049d0788e411b06CfAF16853042"),
    usdcAddress: addressFromEnv("USDC_ADDRESS", "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48"),
    limitRaw,
    limitUsdc,
    warningPercent,
    criticalPercent,
    pollIntervalMs: numberFromEnv("POLL_INTERVAL_SECONDS", 60, 10) * 1_000,
    staleAfterMs: numberFromEnv("STALE_AFTER_SECONDS", 180, 30) * 1_000,
    alertReminderMs: numberFromEnv("ALERT_REMINDER_SECONDS", 3_600, 60) * 1_000,
    ...(alertWebhookUrl ? { alertWebhookUrl } : {}),
  };
}
