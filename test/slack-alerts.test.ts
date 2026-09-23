import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  SlackAlerter,
  slackAlertLevel,
  slackDropMessage,
  slackInformationMessage,
  slackMessage,
  type SlackAlertState,
  type SlackAlertStateStore,
} from "../src/slack-alerts.js";
import type { StatusSnapshot } from "../src/types.js";

function snapshot(totalBalanceUsdc: string): StatusSnapshot {
  return {
    status: "healthy",
    checkedAt: "2026-09-23T12:00:00.000Z",
    blockNumber: "123456",
    blockTimestamp: "2026-09-23T11:59:59.000Z",
    chainId: 1,
    psmAddress: "0xpsm",
    pocketAddress: "0xpocket",
    tokenAddress: "0xusdc",
    pocketBalanceUsdc: totalBalanceUsdc,
    psmBalanceUsdc: "0",
    totalBalanceUsdc,
    limitUsdc: "4000000000",
    remainingUsdc: "0",
    utilizationPercent: 100,
    yellowPercent: 95,
    orangePercent: 90,
  };
}

class MemoryStore implements SlackAlertStateStore {
  state?: SlackAlertState;
  async loadSlackAlertState(): Promise<SlackAlertState | undefined> { return this.state; }
  async saveSlackAlertState(state: SlackAlertState): Promise<void> { this.state = state; }
}

describe("slackAlertLevel", () => {
  it("uses strict requested balance boundaries without floating-point comparisons", () => {
    assert.equal(slackAlertLevel("4000000000"), "healthy");
    assert.equal(slackAlertLevel("3999999999.999999"), "below_4_0");
    assert.equal(slackAlertLevel("3900000000"), "below_4_0");
    assert.equal(slackAlertLevel("3899999999.999999"), "below_3_9");
    assert.equal(slackAlertLevel("3800000000"), "below_3_9");
    assert.equal(slackAlertLevel("3799999999.999999"), "below_3_8");
    assert.equal(slackAlertLevel("3700000000"), "below_3_8");
    assert.equal(slackAlertLevel("3699999999.999999"), "below_3_7");
    assert.equal(slackAlertLevel("3600000000"), "below_3_7");
    assert.equal(slackAlertLevel("3599999999.999999"), "below_3_6");
    assert.equal(slackAlertLevel("3500000000"), "below_3_6");
    assert.equal(slackAlertLevel("3499999999.999999"), "below_3_5");
  });

  it("uses team mentions only at important and critical thresholds", () => {
    assert.doesNotMatch(slackMessage(snapshot("3950000000"), "below_4_0").text, /<!here>/);
    assert.doesNotMatch(slackMessage(snapshot("3850000000"), "below_3_9").text, /<!here>/);
    for (const level of ["below_3_8", "below_3_7", "below_3_6"] as const) {
      const text = slackMessage(snapshot("3750000000"), level).text;
      assert.match(text, /<!here>/);
      assert.match(text, /SFF should be notified for internal reaction/);
    }
    const critical = slackMessage(snapshot("3490000000"), "below_3_5").text;
    assert.match(critical, /<!here>/);
    assert.match(critical, /🚨 ACTION NEEDED/);
    assert.match(critical, /SFF should be notified urgently that the PSM should be refilled/);
    assert.doesNotMatch(slackDropMessage(snapshot("3980000000"), "4000000000", 20_000_000_000_000n).text, /<!here>/);
    assert.doesNotMatch(slackInformationMessage(snapshot("3980000000")).text, /<!here>|refill|action needed/i);
  });
});

describe("SlackAlerter", () => {
  it("alerts on downward threshold crossings without hourly repeats", async () => {
    const store = new MemoryStore();
    const payloads: Array<{ text: string }> = [];
    const post = async (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
      payloads.push(JSON.parse(String(init?.body)) as { text: string });
      return new Response("ok", { status: 200 });
    };
    const alerter = new SlackAlerter({ webhookUrl: "https://hooks.slack.com/services/test" }, store, post as typeof fetch);
    const start = Date.parse("2026-09-23T12:00:00.000Z");

    await alerter.check(snapshot("4050000000"), start);
    assert.equal(payloads.length, 1, "the initial healthy check sends only the information note");
    await alerter.check(snapshot("3950000000"), start + 600_000);
    assert.equal(payloads.length, 2);
    assert.match(payloads[1]!.text, /below 4\.0B/);
    assert.doesNotMatch(payloads[1]!.text, /<!here>/);

    await alerter.check(snapshot("3850000000"), start + 1_200_000);
    assert.equal(payloads.length, 3);
    assert.match(payloads[2]!.text, /below 3\.9B/);

    await alerter.check(snapshot("3750000000"), start + 1_800_000);
    assert.equal(payloads.length, 4);
    assert.match(payloads[3]!.text, /<!here>/);
    assert.match(payloads[3]!.text, /SFF should be notified/);

    await alerter.check(snapshot("3850000000"), start + 2_400_000);
    assert.equal(payloads.length, 4, "does not alert on a partial upward move");
    await alerter.check(snapshot("3750000000"), start + 3_000_000);
    assert.equal(payloads.length, 5, "alerts when the important threshold is crossed downward again");

    await alerter.check(snapshot("3750000000"), start + 7_200_000);
    assert.equal(payloads.length, 5, "does not repeat a threshold merely because time elapsed");

    await alerter.check(snapshot("4050000000"), start + 7_800_000);
    assert.equal(payloads.length, 6);
    assert.match(payloads[5]!.text, /recovered/);
  });

  it("restores the observed level to avoid duplicate messages after restart", async () => {
    const store = new MemoryStore();
    store.state = {
      level: "below_4_0",
      lastCheckedAt: "2026-09-23T12:00:00.000Z",
      lastBalanceUsdc: "3940000000",
      lastInfoSentAt: "2026-09-23T12:00:00.000Z",
    };
    let posts = 0;
    const post = async (): Promise<Response> => { posts += 1; return new Response("ok"); };
    const alerter = new SlackAlerter({ webhookUrl: "https://hooks.slack.com/services/test" }, store, post as typeof fetch);

    await alerter.check(snapshot("3940000000"), Date.parse("2026-09-23T12:10:00.000Z"));
    assert.equal(posts, 0);
  });

  it("reports an active threshold on the first check after the policy migration", async () => {
    const store = new MemoryStore();
    store.state = {
      level: "healthy",
      lastCheckedAt: "2026-09-23T12:00:00.000Z",
      lastBalanceUsdc: "3750000000",
      lastInfoSentAt: "2026-09-23T12:00:00.000Z",
    };
    const payloads: Array<{ text: string }> = [];
    const post = async (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
      payloads.push(JSON.parse(String(init?.body)) as { text: string });
      return new Response("ok");
    };
    const alerter = new SlackAlerter({ webhookUrl: "https://hooks.slack.com/services/test" }, store, post as typeof fetch);

    await alerter.check(snapshot("3750000000"), Date.parse("2026-09-23T12:10:00.000Z"));
    assert.equal(payloads.length, 1);
    assert.match(payloads[0]!.text, /<!here>/);
    assert.match(payloads[0]!.text, /below 3\.8B/);
  });

  it("does not replay a tagged crossing when a simultaneous information post fails", async () => {
    const store = new MemoryStore();
    store.state = {
      level: "healthy",
      lastCheckedAt: "2026-09-23T00:00:00.000Z",
      lastBalanceUsdc: "4050000000",
      lastInfoSentAt: "2026-09-23T00:00:00.000Z",
    };
    let posts = 0;
    const failingSecondPost = async (): Promise<Response> => {
      posts += 1;
      return posts === 1 ? new Response("ok") : new Response("failed", { status: 500 });
    };
    const start = Date.parse("2026-09-23T12:00:00.000Z");
    const firstRun = new SlackAlerter(
      { webhookUrl: "https://hooks.slack.com/services/test" },
      store,
      failingSecondPost as typeof fetch,
    );

    await assert.rejects(firstRun.check(snapshot("3750000000"), start), /HTTP 500/);
    assert.equal(store.state?.level, "below_3_8", "the delivered crossing is checkpointed");
    assert.equal(store.state?.lastInfoSentAt, "2026-09-23T00:00:00.000Z", "the failed information post remains due");

    const retryPayloads: Array<{ text: string }> = [];
    const retryPost = async (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
      retryPayloads.push(JSON.parse(String(init?.body)) as { text: string });
      return new Response("ok");
    };
    const retry = new SlackAlerter({ webhookUrl: "https://hooks.slack.com/services/test" }, store, retryPost as typeof fetch);
    await retry.check(snapshot("3750000000"), start + 600_000);
    assert.equal(retryPayloads.length, 1);
    assert.match(retryPayloads[0]!.text, /PSM balance update/);
    assert.doesNotMatch(retryPayloads[0]!.text, /<!here>/);
  });

  it("sends an untagged note only when the consecutive-check drop is greater than 10M", async () => {
    const store = new MemoryStore();
    const payloads: Array<{ text: string }> = [];
    const post = async (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
      payloads.push(JSON.parse(String(init?.body)) as { text: string });
      return new Response("ok");
    };
    const alerter = new SlackAlerter({ webhookUrl: "https://hooks.slack.com/services/test" }, store, post as typeof fetch);
    const start = Date.parse("2026-09-23T12:00:00.000Z");

    await alerter.check(snapshot("4200000000"), start);
    await alerter.check(snapshot("4190000000"), start + 600_000);
    assert.equal(payloads.length, 1, "the first check only sends the scheduled information note");

    await alerter.check(snapshot("4179999999"), start + 1_200_000);
    assert.equal(payloads.length, 2);
    assert.match(payloads[1]!.text, /balance movement/i);
    assert.match(payloads[1]!.text, /10.000M USDC/);
    assert.doesNotMatch(payloads[1]!.text, /<!here>/);
  });

  it("does not turn a drop-only note into another tagged threshold alert", async () => {
    const store = new MemoryStore();
    const payloads: Array<{ text: string }> = [];
    const post = async (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
      payloads.push(JSON.parse(String(init?.body)) as { text: string });
      return new Response("ok");
    };
    const alerter = new SlackAlerter({ webhookUrl: "https://hooks.slack.com/services/test" }, store, post as typeof fetch);
    const start = Date.parse("2026-09-23T12:00:00.000Z");

    await alerter.check(snapshot("3750000000"), start);
    assert.match(payloads[0]!.text, /<!here>/);
    await alerter.check(snapshot("3739000000"), start + 600_000);
    assert.equal(payloads.length, 3);
    assert.match(payloads[2]!.text, /balance movement/i);
    assert.doesNotMatch(payloads[2]!.text, /<!here>/);
  });

  it("sends an untagged informational balance update every twelve hours", async () => {
    const store = new MemoryStore();
    const payloads: Array<{ text: string }> = [];
    const post = async (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
      payloads.push(JSON.parse(String(init?.body)) as { text: string });
      return new Response("ok");
    };
    const alerter = new SlackAlerter({ webhookUrl: "https://hooks.slack.com/services/test" }, store, post as typeof fetch);
    const start = Date.parse("2026-09-23T00:00:00.000Z");

    await alerter.check(snapshot("4100000000"), start);
    assert.equal(payloads.length, 1);
    assert.match(payloads[0]!.text, /PSM balance update/);
    assert.doesNotMatch(payloads[0]!.text, /<!here>|refill|action needed/i);

    await alerter.check(snapshot("4100000000"), start + 11 * 60 * 60 * 1_000);
    assert.equal(payloads.length, 1);

    await alerter.check(snapshot("4100000000"), start + 12 * 60 * 60 * 1_000);
    assert.equal(payloads.length, 2);
    assert.equal(store.state?.lastInfoSentAt, "2026-09-23T12:00:00.000Z");
  });
});
