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
import type { SlackAlertSnapshot } from "../src/slack-alerts.js";

function snapshot(totalBalanceUsdc: string): SlackAlertSnapshot {
  return {
    circulatingSupply: "10000000000",
    supplyCheckedAt: "2026-09-23T12:00:00.000Z",
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
  it("uses exact relative boundaries without floating-point comparisons", () => {
    for (const [balance, expected] of [
      ["3000000000", "healthy"], ["2999999999.999999", "below_30"],
      ["2800000000", "below_30"], ["2799999999.999999", "below_28"],
      ["2500000000", "below_28"], ["2499999999.999999", "below_25"],
      ["2000000000", "below_25"], ["1999999999.999999", "below_20"],
    ] as const) assert.equal(slackAlertLevel(balance, "10000000000"), expected);
    assert.equal(slackAlertLevel("2500000000", "10000000000.000000000000000001"), "below_25");
    assert.throws(() => slackAlertLevel("1", "0"), /positive/);
    assert.throws(() => slackAlertLevel("1", "NaN"), /decimal/);
  });

  it("uses team mentions only at important and critical thresholds", () => {
    assert.doesNotMatch(slackMessage(snapshot("2950000000"), "below_30").text, /<!here>/);
    assert.doesNotMatch(slackMessage(snapshot("2750000000"), "below_28").text, /<!here>/);
    for (const level of ["below_25"] as const) {
      const text = slackMessage(snapshot("2450000000"), level).text;
      assert.match(text, /<!here>/);
      assert.match(text, /SFF should be notified for internal reaction/);
    }
    const critical = slackMessage(snapshot("1990000000"), "below_20").text;
    assert.match(critical, /<!here>/);
    assert.match(critical, /🚨 ACTION NEEDED/);
    assert.match(critical, /SFF should be notified urgently that the PSM should be refilled/);
    assert.doesNotMatch(slackDropMessage(snapshot("3980000000"), "4000000000", 20_000_000_000_000n).text, /<!here>/);
    assert.doesNotMatch(slackInformationMessage(snapshot("3980000000")).text, /<!here>|refill|action needed/i);
    assert.match(slackMessage(snapshot("1990000000"), "below_20", false, 0n, "<!subteam^S123>").text, /<!subteam\^S123>/);
  });
});

describe("SlackAlerter", () => {
  it("reloads persisted state after a transient load failure rather than repeating an alert", async () => {
    let loads = 0, posts = 0;
    const store: SlackAlertStateStore = {
      async loadSlackAlertState() {
        if (++loads === 1) throw new Error("database temporarily unavailable");
        return { level: "below_25", lastCheckedAt: "2026-09-23T12:00:00Z", lastBalanceUsdc: "2450000000", lastInfoSentAt: "2026-09-23T12:00:00Z" };
      },
      async saveSlackAlertState() {},
    };
    const post = (async () => { posts++; return new Response("ok"); }) as typeof fetch;
    const alerter = new SlackAlerter({ webhookUrl: "https://example.com/slack" }, store, post);
    const now = Date.parse("2026-09-23T12:10:00Z");
    await assert.rejects(alerter.check(snapshot("2450000000"), now), /temporarily unavailable/);
    await alerter.check(snapshot("2450000000"), now);
    assert.equal(loads, 2); assert.equal(posts, 0);
  });
  it("reacts to supply growth with unchanged USDC and persists the ratio band", async () => {
    const store = new MemoryStore(), payloads: { text: string }[] = [];
    const post = (async (_url, init) => { payloads.push(JSON.parse(String(init?.body))); return new Response("ok"); }) as typeof fetch;
    const start = Date.parse("2026-09-23T12:00:00Z");
    const alerter = new SlackAlerter({ webhookUrl: "https://example.com/slack" }, store, post);
    await alerter.check({ ...snapshot("2700000000"), circulatingSupply: "8700000000" }, start);
    await alerter.check(snapshot("2700000000"), start + 600000);
    assert.equal(payloads.length, 2); assert.match(payloads[1]!.text, /below 28%/);
    assert.equal(store.state?.lastCirculatingSupply, "10000000000");
    const restarted = new SlackAlerter({ webhookUrl: "https://example.com/slack" }, store, post);
    await restarted.check(snapshot("2700000000"), start + 1200000);
    assert.equal(payloads.length, 2);
  });
  it("rejects missing or invalid supply without sending or advancing state", async () => {
    const store = new MemoryStore(); let posts = 0;
    const post = (async () => { posts++; return new Response("ok"); }) as typeof fetch;
    const alerter = new SlackAlerter({ webhookUrl: "https://example.com/slack" }, store, post);
    await assert.rejects(alerter.check({ ...snapshot("1000000000"), circulatingSupply: "0" }), /positive/);
    assert.equal(posts, 0); assert.equal(store.state, undefined);
  });
  it("alerts on downward threshold crossings without hourly repeats", async () => {
    const store = new MemoryStore();
    const payloads: Array<{ text: string }> = [];
    const post = async (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
      payloads.push(JSON.parse(String(init?.body)) as { text: string });
      return new Response("ok", { status: 200 });
    };
    const alerter = new SlackAlerter({ webhookUrl: "https://hooks.slack.com/services/test" }, store, post as typeof fetch);
    const start = Date.parse("2026-09-23T12:00:00.000Z");

    await alerter.check(snapshot("3050000000"), start);
    assert.equal(payloads.length, 1, "the initial healthy check sends only the information note");
    await alerter.check(snapshot("2950000000"), start + 600_000);
    assert.equal(payloads.length, 2);
    assert.match(payloads[1]!.text, /below 30%/);
    assert.doesNotMatch(payloads[1]!.text, /<!here>/);

    await alerter.check(snapshot("2750000000"), start + 1_200_000);
    assert.equal(payloads.length, 3);
    assert.match(payloads[2]!.text, /below 28%/);

    await alerter.check(snapshot("2450000000"), start + 1_800_000);
    assert.equal(payloads.length, 4);
    assert.match(payloads[3]!.text, /<!here>/);
    assert.match(payloads[3]!.text, /SFF should be notified/);

    await alerter.check(snapshot("2750000000"), start + 2_400_000);
    assert.equal(payloads.length, 4, "does not alert on a partial upward move");
    await alerter.check(snapshot("2450000000"), start + 3_000_000);
    assert.equal(payloads.length, 5, "alerts when the important threshold is crossed downward again");

    await alerter.check(snapshot("2450000000"), start + 7_200_000);
    assert.equal(payloads.length, 5, "does not repeat a threshold merely because time elapsed");

    await alerter.check(snapshot("3050000000"), start + 7_800_000);
    assert.equal(payloads.length, 6);
    assert.match(payloads[5]!.text, /recovered/);
  });

  it("restores the observed level to avoid duplicate messages after restart", async () => {
    const store = new MemoryStore();
    store.state = {
      level: "below_30",
      lastCheckedAt: "2026-09-23T12:00:00.000Z",
      lastBalanceUsdc: "2940000000",
      lastInfoSentAt: "2026-09-23T12:00:00.000Z",
    };
    let posts = 0;
    const post = async (): Promise<Response> => { posts += 1; return new Response("ok"); };
    const alerter = new SlackAlerter({ webhookUrl: "https://hooks.slack.com/services/test" }, store, post as typeof fetch);

    await alerter.check(snapshot("2940000000"), Date.parse("2026-09-23T12:10:00.000Z"));
    assert.equal(posts, 0);
  });

  it("reports an active threshold on the first check after the policy migration", async () => {
    const store = new MemoryStore();
    store.state = {
      level: "healthy",
      lastCheckedAt: "2026-09-23T12:00:00.000Z",
      lastBalanceUsdc: "2450000000",
      lastInfoSentAt: "2026-09-23T12:00:00.000Z",
    };
    const payloads: Array<{ text: string }> = [];
    const post = async (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
      payloads.push(JSON.parse(String(init?.body)) as { text: string });
      return new Response("ok");
    };
    const alerter = new SlackAlerter({ webhookUrl: "https://hooks.slack.com/services/test" }, store, post as typeof fetch);

    await alerter.check(snapshot("2450000000"), Date.parse("2026-09-23T12:10:00.000Z"));
    assert.equal(payloads.length, 1);
    assert.match(payloads[0]!.text, /<!here>/);
    assert.match(payloads[0]!.text, /below 25%/);
  });

  it("does not replay a tagged crossing when a simultaneous information post fails", async () => {
    const store = new MemoryStore();
    store.state = {
      level: "healthy",
      lastCheckedAt: "2026-09-23T00:00:00.000Z",
      lastBalanceUsdc: "3050000000",
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

    await assert.rejects(firstRun.check(snapshot("2450000000"), start), /HTTP 500/);
    assert.equal(store.state?.level, "below_25", "the delivered crossing is checkpointed");
    assert.equal(store.state?.lastInfoSentAt, "2026-09-23T00:00:00.000Z", "the failed information post remains due");

    const retryPayloads: Array<{ text: string }> = [];
    const retryPost = async (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
      retryPayloads.push(JSON.parse(String(init?.body)) as { text: string });
      return new Response("ok");
    };
    const retry = new SlackAlerter({ webhookUrl: "https://hooks.slack.com/services/test" }, store, retryPost as typeof fetch);
    await retry.check(snapshot("2450000000"), start + 600_000);
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

    await alerter.check(snapshot("2450000000"), start);
    assert.match(payloads[0]!.text, /<!here>/);
    await alerter.check(snapshot("2439000000"), start + 600_000);
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
