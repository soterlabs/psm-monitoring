import { parseUnits } from "viem";
import type { StatusSnapshot } from "./types.js";

export const slackAlertLevels = ["healthy", "could_refill", "refill", "urgent", "action_needed"] as const;
export type SlackAlertLevel = (typeof slackAlertLevels)[number];

export interface SlackAlertState {
  level: SlackAlertLevel;
  lastCheckedAt: string;
  lastBalanceUsdc: string;
  lastThresholdSentAt?: string;
  lastInfoSentAt?: string;
}

export interface SlackAlertStateStore {
  loadSlackAlertState(): Promise<SlackAlertState | undefined>;
  saveSlackAlertState(state: SlackAlertState): Promise<void>;
}

export interface SlackAlertConfig {
  webhookUrl?: string;
  reminderMs: number;
}

const THRESHOLDS = {
  couldRefill: parseUnits("3950000000", 6),
  refill: parseUnits("3900000000", 6),
  urgent: parseUnits("3850000000", 6),
  actionNeeded: parseUnits("3800000000", 6),
};
const LARGE_DROP_RAW = parseUnits("10000000", 6);
const CRON_START_TOLERANCE_MS = 120_000;
const INFORMATION_INTERVAL_MS = 12 * 60 * 60 * 1_000;

export function slackAlertLevel(balanceUsdc: string): SlackAlertLevel {
  const balance = parseUnits(balanceUsdc, 6);
  if (balance < THRESHOLDS.actionNeeded) return "action_needed";
  if (balance < THRESHOLDS.urgent) return "urgent";
  if (balance < THRESHOLDS.refill) return "refill";
  if (balance < THRESHOLDS.couldRefill) return "could_refill";
  return "healthy";
}

function displayBalance(balanceUsdc: string): string {
  return `${(Number(balanceUsdc) / 1_000_000_000).toFixed(3)}B USDC`;
}

function displayDrop(dropRaw: bigint): string {
  return `${(Number(dropRaw) / 1_000_000_000_000).toFixed(3)}M USDC`;
}

export function slackMessage(
  snapshot: StatusSnapshot,
  level: SlackAlertLevel,
  recovery = false,
  dropRaw = 0n,
): { text: string; blocks: unknown[] } {
  const balance = displayBalance(snapshot.totalBalanceUsdc);
  const details = `Balance: *${balance}* · Ethereum block: \`${snapshot.blockNumber}\``;
  let title: string;
  let message: string;

  if (recovery) {
    title = "✅ PSM balance recovered";
    message = `The PSM balance is back at or above 3.95B USDC.\n${details}`;
  } else if (level === "action_needed") {
    title = "🚨 ACTION NEEDED";
    message = `<!here> The PSM balance is below 3.80B USDC and should be refilled urgently.\n${details}`;
  } else if (level === "urgent") {
    title = "PSM urgent refill alert";
    message = `<!here> The PSM balance is below 3.85B USDC and should be refilled urgently.\n${details}`;
  } else if (level === "refill") {
    title = "PSM refill alert";
    message = `<!here> The PSM balance is below 3.90B USDC and should be refilled.\n${details}`;
  } else {
    title = "PSM refill capacity notice";
    message = `The PSM balance is below 3.95B USDC and could be refilled.\n${details}`;
  }

  if (dropRaw > LARGE_DROP_RAW) {
    message += `\n_Note: the balance decreased by ${displayDrop(dropRaw)} between the two latest 10-minute checks._`;
  }

  const text = `${title}\n${message.replace(/\*/g, "").replace(/`/g, "")}`;
  return {
    text,
    blocks: [
      { type: "header", text: { type: "plain_text", text: title, emoji: true } },
      { type: "section", text: { type: "mrkdwn", text: message } },
      { type: "context", elements: [{ type: "mrkdwn", text: `Checked ${snapshot.checkedAt} · <https://psm-monitoring-production.up.railway.app|Open PSM monitor>` }] },
    ],
  };
}

export function slackDropMessage(snapshot: StatusSnapshot, previousBalanceUsdc: string, dropRaw: bigint): { text: string; blocks: unknown[] } {
  const title = "PSM balance movement";
  const message = `The PSM balance decreased by *${displayDrop(dropRaw)}* between two consecutive 10-minute checks.\nPrevious: *${displayBalance(previousBalanceUsdc)}* · Current: *${displayBalance(snapshot.totalBalanceUsdc)}*\nThis is an informational note; no team mention was sent.`;
  return {
    text: `${title}\n${message.replace(/\*/g, "")}`,
    blocks: [
      { type: "header", text: { type: "plain_text", text: title, emoji: true } },
      { type: "section", text: { type: "mrkdwn", text: message } },
      { type: "context", elements: [{ type: "mrkdwn", text: `Checked ${snapshot.checkedAt} · Ethereum block \`${snapshot.blockNumber}\` · <https://psm-monitoring-production.up.railway.app|Open PSM monitor>` }] },
    ],
  };
}

export function slackInformationMessage(snapshot: StatusSnapshot): { text: string; blocks: unknown[] } {
  const title = "ℹ️ PSM balance update";
  const message = `Current PSM USDC balance: *${displayBalance(snapshot.totalBalanceUsdc)}*.`;
  return {
    text: `${title}\n${message.replace(/\*/g, "")}\nEthereum block: ${snapshot.blockNumber} · Checked ${snapshot.checkedAt}`,
    blocks: [
      { type: "header", text: { type: "plain_text", text: title, emoji: true } },
      { type: "section", text: { type: "mrkdwn", text: message } },
      { type: "context", elements: [{ type: "mrkdwn", text: `Checked ${snapshot.checkedAt} · Ethereum block \`${snapshot.blockNumber}\` · <https://psm-monitoring-production.up.railway.app|Open PSM monitor>` }] },
    ],
  };
}

export class SlackAlerter {
  private state: SlackAlertState | undefined;
  private loaded = false;

  constructor(
    private readonly config: SlackAlertConfig,
    private readonly store?: SlackAlertStateStore,
    private readonly post: typeof fetch = fetch,
  ) {}

  async check(snapshot: StatusSnapshot, now = Date.now()): Promise<void> {
    if (!this.config.webhookUrl) return;
    await this.loadState();
    const previous = this.state;

    const level = slackAlertLevel(snapshot.totalBalanceUsdc);
    const changed = previous?.level !== level;
    const reminderDue = level !== "healthy" && (
      !previous?.lastThresholdSentAt
      || now - Date.parse(previous.lastThresholdSentAt) >= Math.max(0, this.config.reminderMs - CRON_START_TOLERANCE_MS)
    );
    const recovery = level === "healthy" && previous !== undefined && previous.level !== "healthy";
    const shouldSendThreshold = level !== "healthy" ? changed || reminderDue : recovery;
    const informationDue = !previous?.lastInfoSentAt
      || now - Date.parse(previous.lastInfoSentAt) >= INFORMATION_INTERVAL_MS - CRON_START_TOLERANCE_MS;
    const previousBalanceRaw = previous ? parseUnits(previous.lastBalanceUsdc, 6) : undefined;
    const balanceRaw = parseUnits(snapshot.totalBalanceUsdc, 6);
    const dropRaw = previousBalanceRaw !== undefined && previousBalanceRaw > balanceRaw ? previousBalanceRaw - balanceRaw : 0n;
    const largeDrop = dropRaw > LARGE_DROP_RAW;
    let lastThresholdSentAt = previous?.lastThresholdSentAt;
    let lastInfoSentAt = previous?.lastInfoSentAt;

    if (shouldSendThreshold || largeDrop) {
      const payload = shouldSendThreshold
        ? slackMessage(snapshot, level, recovery, dropRaw)
        : slackDropMessage(snapshot, previous!.lastBalanceUsdc, dropRaw);
      const response = await this.post(this.config.webhookUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) throw new Error(`Slack webhook returned HTTP ${response.status}`);
      if (shouldSendThreshold) lastThresholdSentAt = new Date(now).toISOString();
      console.log(JSON.stringify({ event: "slack_alert_sent", level, recovery, largeDrop, balanceUsdc: snapshot.totalBalanceUsdc }));
    }

    if (informationDue) {
      const response = await this.post(this.config.webhookUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(slackInformationMessage(snapshot)),
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) throw new Error(`Slack webhook returned HTTP ${response.status}`);
      lastInfoSentAt = new Date(now).toISOString();
      console.log(JSON.stringify({ event: "slack_information_sent", balanceUsdc: snapshot.totalBalanceUsdc }));
    }

    this.state = {
      level,
      lastCheckedAt: new Date(now).toISOString(),
      lastBalanceUsdc: snapshot.totalBalanceUsdc,
      ...(lastThresholdSentAt ? { lastThresholdSentAt } : {}),
      ...(lastInfoSentAt ? { lastInfoSentAt } : {}),
    };
    await this.persistState();
  }

  private async loadState(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    if (!this.store) return;
    this.state = await this.store.loadSlackAlertState();
  }

  private async persistState(): Promise<void> {
    if (!this.store || !this.state) return;
    await this.store.saveSlackAlertState(this.state);
  }
}
