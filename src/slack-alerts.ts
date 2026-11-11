import { formatUnits, parseUnits } from "viem";
import type { StatusSnapshot } from "./types.js";
import { supplyRaw, reserveBand, type CirculatingSupply } from "./supply.js";

export type SlackAlertSnapshot = StatusSnapshot & CirculatingSupply;

export const slackAlertLevels = ["healthy", "below_30", "below_28", "below_25", "below_20"] as const;
export type SlackAlertLevel = (typeof slackAlertLevels)[number];

export interface SlackAlertState {
  level: SlackAlertLevel;
  lastCheckedAt: string;
  lastBalanceUsdc: string;
  lastInfoSentAt?: string;
  lastCirculatingSupply?: string;
}

export interface SlackAlertStateStore {
  loadSlackAlertState(): Promise<SlackAlertState | undefined>;
  saveSlackAlertState(state: SlackAlertState): Promise<void>;
}

export interface SlackAlertConfig {
  webhookUrl?: string;
  sffMention?: string;
}

const LARGE_DROP_RAW = parseUnits("10000000", 6);
const CRON_START_TOLERANCE_MS = 120_000;
const INFORMATION_INTERVAL_MS = 12 * 60 * 60 * 1_000;
const SEVERITY: Record<SlackAlertLevel, number> = Object.fromEntries(
  slackAlertLevels.map((level, index) => [level, index]),
) as Record<SlackAlertLevel, number>;

export function slackAlertLevel(balanceUsdc: string, circulatingSupply: string): SlackAlertLevel {
  return reserveBand(balanceUsdc, circulatingSupply);
}

function coverage(snapshot: SlackAlertSnapshot): string {
  const numerator = parseUnits(snapshot.totalBalanceUsdc, 6) * 10n ** 12n * 100n;
  const denominator = supplyRaw(snapshot.circulatingSupply);
  // Round directly from the token amounts to avoid binary floating-point errors
  // at half-hundredths.
  const hundredths = (numerator * 100n + denominator / 2n) / denominator;
  const rounded = `${hundredths / 100n}.${(hundredths % 100n).toString().padStart(2, "0")}`;
  // Avoid a below-threshold alert displaying a rounded ratio at the threshold.
  const crossesBoundary = [20n, 25n, 28n, 30n].some(value => numerator < denominator * value && hundredths >= value * 100n);
  return `${crossesBoundary ? formatUnits(numerator * 1_000_000n / denominator, 6) : rounded}%`;
}

function reserveRatioLine(snapshot: SlackAlertSnapshot): string {
  return `Current reserve ratio: *${coverage(snapshot)}* of circulating USDS + DAI (*${(Number(snapshot.circulatingSupply) / 1e9).toFixed(3)}B*).`;
}

function displayBalance(balanceUsdc: string): string {
  return `${(Number(balanceUsdc) / 1_000_000_000).toFixed(3)}B USDC`;
}

function displayDrop(dropRaw: bigint): string {
  return `${(Number(dropRaw) / 1_000_000_000_000).toFixed(3)}M USDC`;
}

export function slackMessage(
  snapshot: SlackAlertSnapshot,
  level: SlackAlertLevel,
  recovery = false,
  dropRaw = 0n,
  sffMention?: string,
): { text: string; blocks: unknown[] } {
  const balance = displayBalance(snapshot.totalBalanceUsdc);
  const details = `${reserveRatioLine(snapshot)}\nBalance: *${balance}* · Ethereum block: \`${snapshot.blockNumber}\`\nSupply checked: ${snapshot.supplyCheckedAt}`;
  const sff = sffMention ? `${sffMention} (SFF)` : "SFF";
  let title: string;
  let message: string;

  if (recovery) {
    title = "✅ PSM balance recovered";
    message = `The PSM USDC balance is back at or above 30% of circulating USDS + DAI.\n${details}`;
  } else if (level === "below_20") {
    title = "🚨 ACTION NEEDED";
    message = `<!here> 🚨 The PSM USDC balance crossed below 20% of circulating USDS + DAI. ${sff} should be notified urgently that the PSM should be refilled.\n${details}`;
  } else if (level === "below_25") {
    title = "⚠️ Important PSM balance threshold";
    message = `<!here> The PSM USDC balance crossed below 25% of circulating USDS + DAI. ${sff} should be notified for internal reaction.\n${details}`;
  } else if (level === "below_28") {
    title = "PSM reserve ratio below 28%";
    message = `The PSM USDC balance crossed below 28% of circulating USDS + DAI.\n${details}`;
  } else {
    title = "PSM reserve ratio below 30%";
    message = `The PSM USDC balance crossed below 30% of circulating USDS + DAI.\n${details}`;
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

export function slackDropMessage(snapshot: SlackAlertSnapshot, previousBalanceUsdc: string, dropRaw: bigint): { text: string; blocks: unknown[] } {
  const title = "PSM balance movement";
  const message = `The PSM balance decreased by *${displayDrop(dropRaw)}* between two consecutive 10-minute checks.\nPrevious: *${displayBalance(previousBalanceUsdc)}* · Current: *${displayBalance(snapshot.totalBalanceUsdc)}*\n${reserveRatioLine(snapshot)}\nSupply checked: ${snapshot.supplyCheckedAt}\nThis is an informational note; no team mention was sent.`;
  return {
    text: `${title}\n${message.replace(/\*/g, "")}`,
    blocks: [
      { type: "header", text: { type: "plain_text", text: title, emoji: true } },
      { type: "section", text: { type: "mrkdwn", text: message } },
      { type: "context", elements: [{ type: "mrkdwn", text: `Checked ${snapshot.checkedAt} · Ethereum block \`${snapshot.blockNumber}\` · <https://psm-monitoring-production.up.railway.app|Open PSM monitor>` }] },
    ],
  };
}

export function slackInformationMessage(snapshot: SlackAlertSnapshot): { text: string; blocks: unknown[] } {
  const title = "ℹ️ PSM balance update";
  const message = `Current PSM USDC balance: *${displayBalance(snapshot.totalBalanceUsdc)}*\n${reserveRatioLine(snapshot)}\nSupply checked: ${snapshot.supplyCheckedAt}`;
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

  async check(snapshot: SlackAlertSnapshot, now = Date.now()): Promise<void> {
    if (!this.config.webhookUrl) return;
    if (this.config.sffMention && !/^(<@(?:U|W)[A-Z0-9]+>|<!subteam\^S[A-Z0-9]+>)$/.test(this.config.sffMention)) {
      throw new Error("SLACK_SFF_MENTION must be a Slack user or user-group mention token");
    }
    const level = slackAlertLevel(snapshot.totalBalanceUsdc, snapshot.circulatingSupply);
    await this.loadState();
    const previous = this.state;

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
      lastCirculatingSupply: snapshot.circulatingSupply,
      ...(lastInfoSentAt ? { lastInfoSentAt } : {}),
    });

    if (shouldSendThreshold || largeDrop) {
      const payload = shouldSendThreshold
        ? slackMessage(snapshot, level, recovery, dropRaw, this.config.sffMention)
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
    if (this.store) this.state = await this.store.loadSlackAlertState();
    this.loaded = true;
  }

  private async persistState(): Promise<void> {
    if (!this.store || !this.state) return;
    await this.store.saveSlackAlertState(this.state);
  }
}
