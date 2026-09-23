import type { Config } from "./config.js";
import { readBalance, type makeClient } from "./chain.js";
import { buildSnapshot } from "./status.js";
import type { Level, StatusSnapshot } from "./types.js";
import { safeErrorMessage } from "./errors.js";

type Client = ReturnType<typeof makeClient>;

export class Monitor {
  snapshot?: StatusSnapshot;
  lastError?: { message: string; at: string };
  private timer?: NodeJS.Timeout;
  private running = false;
  private lastAlert?: { level: Level; at: number };

  constructor(private readonly client: Client, private readonly config: Config) {}

  async poll(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const reading = await readBalance(this.client, this.config);
      const next = buildSnapshot(
        reading,
        this.config.limitRaw,
        this.config.yellowPercent,
        this.config.orangePercent,
      );
      this.snapshot = next;
      delete this.lastError;
      console.log(JSON.stringify({ event: "balance_checked", ...next }));
      await this.maybeGenericAlert(next);
    } catch (error) {
      const message = safeErrorMessage(error);
      this.lastError = { message, at: new Date().toISOString() };
      console.error(JSON.stringify({ event: "poll_failed", message, at: this.lastError.at }));
    } finally {
      this.running = false;
    }
  }

  start(): void {
    this.timer = setInterval(() => void this.poll(), this.config.pollIntervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  isFresh(now = Date.now()): boolean {
    return Boolean(this.snapshot && now - Date.parse(this.snapshot.checkedAt) <= this.config.staleAfterMs);
  }

  /** Retains the pre-existing generic webhook integration independently of Slack policy alerts. */
  private async maybeGenericAlert(snapshot: StatusSnapshot): Promise<void> {
    if (!this.config.alertWebhookUrl) return;
    const now = Date.now();
    const isAlert = snapshot.status !== "healthy";
    const changed = this.lastAlert?.level !== snapshot.status;
    const reminderDue = !this.lastAlert || now - this.lastAlert.at >= this.config.alertReminderMs;
    if (!changed && !reminderDue) return;
    if (!isAlert && !this.lastAlert) return;

    const message = isAlert
      ? `[PSM ${snapshot.status.toUpperCase()}] ${snapshot.totalBalanceUsdc} USDC (${snapshot.utilizationPercent.toFixed(2)}%) of ${snapshot.limitUsdc} target.`
      : `[PSM HEALTHY] ${snapshot.totalBalanceUsdc} USDC (${snapshot.utilizationPercent.toFixed(2)}%) of ${snapshot.limitUsdc} target.`;
    try {
      const response = await fetch(this.config.alertWebhookUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: message, content: message, event: { type: "psm_balance", ...snapshot } }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) throw new Error(`webhook returned HTTP ${response.status}`);
      this.lastAlert = { level: snapshot.status, at: now };
    } catch (error) {
      console.error(JSON.stringify({
        event: "alert_failed",
        message: safeErrorMessage(error),
        at: new Date().toISOString(),
      }));
    }
  }
}
