import { parseUnits } from "viem";
import { safeErrorMessage } from "./errors.js";
import type { StatusSnapshot } from "./types.js";

export const slackAlertLevels = ["healthy", "could_refill", "refill", "urgent", "action_needed"] as const;
export type SlackAlertLevel = (typeof slackAlertLevels)[number];

export interface SlackAlertState {
  level: SlackAlertLevel;
  lastCheckedAt: string;
  lastSentAt?: string;
}

export interface SlackAlertStateStore {
  loadSlackAlertState(): Promise<SlackAlertState | undefined>;
  saveSlackAlertState(state: SlackAlertState): Promise<void>;
}

export interface SlackAlertConfig {
  webhookUrl?: string;
  checkIntervalMs: number;
  reminderMs: number;
}

const THRESHOLDS = {
  couldRefill: parseUnits("3950000000", 6),
  refill: parseUnits("3900000000", 6),
  urgent: parseUnits("3850000000", 6),
  actionNeeded: parseUnits("3800000000", 6),
};

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

export function slackMessage(snapshot: StatusSnapshot, level: SlackAlertLevel, recovery = false): { text: string; blocks: unknown[] } {
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
    if (previous && now - Date.parse(previous.lastCheckedAt) < this.config.checkIntervalMs) return;

    const level = slackAlertLevel(snapshot.totalBalanceUsdc);
    const changed = previous?.level !== level;
    const reminderDue = level !== "healthy" && (!previous?.lastSentAt || now - Date.parse(previous.lastSentAt) >= this.config.reminderMs);
    const recovery = level === "healthy" && previous !== undefined && previous.level !== "healthy";
    const shouldSend = level !== "healthy" ? changed || reminderDue : recovery;
    let lastSentAt = previous?.lastSentAt;

    if (shouldSend) {
      const response = await this.post(this.config.webhookUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(slackMessage(snapshot, level, recovery)),
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) throw new Error(`Slack webhook returned HTTP ${response.status}`);
      lastSentAt = new Date(now).toISOString();
      console.log(JSON.stringify({ event: "slack_alert_sent", level, recovery, balanceUsdc: snapshot.totalBalanceUsdc }));
    }

    this.state = {
      level,
      lastCheckedAt: new Date(now).toISOString(),
      ...(lastSentAt ? { lastSentAt } : {}),
    };
    await this.persistState();
  }

  private async loadState(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    if (!this.store) return;
    try {
      this.state = await this.store.loadSlackAlertState();
    } catch (error) {
      console.error(JSON.stringify({ event: "slack_alert_state_load_failed", message: safeErrorMessage(error) }));
    }
  }

  private async persistState(): Promise<void> {
    if (!this.store || !this.state) return;
    try {
      await this.store.saveSlackAlertState(this.state);
    } catch (error) {
      console.error(JSON.stringify({ event: "slack_alert_state_save_failed", message: safeErrorMessage(error) }));
    }
  }
}
