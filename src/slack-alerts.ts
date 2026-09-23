import { parseUnits } from "viem";
import type { StatusSnapshot } from "./types.js";

export const slackAlertLevels = ["healthy", "below_4_0", "below_3_9", "below_3_8", "below_3_7", "below_3_6", "below_3_5"] as const;
export type SlackAlertLevel = (typeof slackAlertLevels)[number];

export interface SlackAlertState {
  level: SlackAlertLevel;
  lastCheckedAt: string;
  lastBalanceUsdc: string;
  lastInfoSentAt?: string;
}

export interface SlackAlertStateStore {
  loadSlackAlertState(): Promise<SlackAlertState | undefined>;
  saveSlackAlertState(state: SlackAlertState): Promise<void>;
}

export interface SlackAlertConfig {
  webhookUrl?: string;
}

const THRESHOLDS = {
  four: parseUnits("4000000000", 6),
  threeNine: parseUnits("3900000000", 6),
  threeEight: parseUnits("3800000000", 6),
  threeSeven: parseUnits("3700000000", 6),
  threeSix: parseUnits("3600000000", 6),
  threeFive: parseUnits("3500000000", 6),
};
const LARGE_DROP_RAW = parseUnits("10000000", 6);
const CRON_START_TOLERANCE_MS = 120_000;
const INFORMATION_INTERVAL_MS = 12 * 60 * 60 * 1_000;
const SEVERITY: Record<SlackAlertLevel, number> = Object.fromEntries(
  slackAlertLevels.map((level, index) => [level, index]),
) as Record<SlackAlertLevel, number>;

export function slackAlertLevel(balanceUsdc: string): SlackAlertLevel {
  const balance = parseUnits(balanceUsdc, 6);
  if (balance < THRESHOLDS.threeFive) return "below_3_5";
  if (balance < THRESHOLDS.threeSix) return "below_3_6";
  if (balance < THRESHOLDS.threeSeven) return "below_3_7";
  if (balance < THRESHOLDS.threeEight) return "below_3_8";
  if (balance < THRESHOLDS.threeNine) return "below_3_9";
  if (balance < THRESHOLDS.four) return "below_4_0";
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
    message = `The PSM balance is back at or above 4.0B USDC.\n${details}`;
  } else if (level === "below_3_5") {
    title = "🚨 ACTION NEEDED";
    message = `<!here> The PSM balance crossed below 3.5B USDC. SFF should be notified urgently that the PSM should be refilled.\n${details}`;
  } else if (level === "below_3_8") {
    title = "⚠️ Important PSM balance threshold";
    message = `<!here> The PSM balance crossed below 3.8B USDC. SFF should be notified for internal reaction.\n${details}`;
  } else if (level === "below_3_7" || level === "below_3_6") {
    const threshold = level === "below_3_7" ? "3.7B" : "3.6B";
    title = "⚠️ Important PSM balance threshold";
    message = `<!here> The PSM balance crossed below ${threshold} USDC. Restating the 3.8B alert: SFF should be notified for internal reaction.\n${details}`;
  } else if (level === "below_3_9") {
    title = "PSM balance below 3.9B";
    message = `The PSM balance crossed below 3.9B USDC.\n${details}`;
  } else {
    title = "PSM balance below 4.0B";
    message = `The PSM balance crossed below 4.0B USDC.\n${details}`;
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
    const recovery = level === "healthy" && previous !== undefined && previous.level !== "healthy";
    const crossedDown = level !== "healthy" && (
      previous === undefined || SEVERITY[level] > SEVERITY[previous.level]
    );
    const shouldSendThreshold = crossedDown || recovery;
    const informationDue = !previous?.lastInfoSentAt
      || now - Date.parse(previous.lastInfoSentAt) >= INFORMATION_INTERVAL_MS - CRON_START_TOLERANCE_MS;
    const previousBalanceRaw = previous ? parseUnits(previous.lastBalanceUsdc, 6) : undefined;
    const balanceRaw = parseUnits(snapshot.totalBalanceUsdc, 6);
    const dropRaw = previousBalanceRaw !== undefined && previousBalanceRaw > balanceRaw ? previousBalanceRaw - balanceRaw : 0n;
    const largeDrop = dropRaw > LARGE_DROP_RAW;
    let lastInfoSentAt = previous?.lastInfoSentAt;
    const nextState = (): SlackAlertState => ({
      level,
      lastCheckedAt: new Date(now).toISOString(),
      lastBalanceUsdc: snapshot.totalBalanceUsdc,
      ...(lastInfoSentAt ? { lastInfoSentAt } : {}),
    });

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
      console.log(JSON.stringify({ event: "slack_alert_sent", level, crossedDown, recovery, largeDrop, balanceUsdc: snapshot.totalBalanceUsdc }));
    }

    // Checkpoint a successfully delivered threshold/drop (or a quiet check)
    // before a separate information post can fail and cause it to be replayed.
    this.state = nextState();
    await this.persistState();

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
      this.state = nextState();
      await this.persistState();
    }
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
