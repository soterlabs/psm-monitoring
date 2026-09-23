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
    assert.equal(slackAlertLevel("3950000000"), "healthy");
    assert.equal(slackAlertLevel("3949999999.999999"), "could_refill");
    assert.equal(slackAlertLevel("3900000000"), "could_refill");
    assert.equal(slackAlertLevel("3899999999.999999"), "refill");
    assert.equal(slackAlertLevel("3850000000"), "refill");
    assert.equal(slackAlertLevel("3849999999.999999"), "urgent");
    assert.equal(slackAlertLevel("3800000000"), "urgent");
    assert.equal(slackAlertLevel("3799999999.999999"), "action_needed");
  });

  it("only mentions here at 3.9B and below and makes the lowest level explicit", () => {
    assert.doesNotMatch(slackMessage(snapshot("3940000000"), "could_refill").text, /<!here>/);
    assert.match(slackMessage(snapshot("3890000000"), "refill").text, /<!here>/);
    assert.match(slackMessage(snapshot("3840000000"), "urgent").text, /<!here>/);
    assert.match(slackMessage(snapshot("3790000000"), "action_needed").text, /<!here>/);
    assert.match(slackMessage(snapshot("3790000000"), "action_needed").text, /🚨 ACTION NEEDED/);
    assert.doesNotMatch(slackDropMessage(snapshot("3980000000"), "4000000000", 20_000_000_000_000n).text, /<!here>/);
    assert.doesNotMatch(slackInformationMessage(snapshot("3980000000")).text, /<!here>|refill|action needed/i);
  });
});

describe("SlackAlerter", () => {
  it("alerts on cron-observed transitions and reminds hourly", async () => {
    const store = new MemoryStore();
    const payloads: Array<{ text: string }> = [];
    const post = async (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
      payloads.push(JSON.parse(String(init?.body)) as { text: string });
      return new Response("ok", { status: 200 });
    };
    const alerter = new SlackAlerter({
      webhookUrl: "https://hooks.slack.com/services/test",
      reminderMs: 3_600_000,
    }, store, post as typeof fetch);
    const start = Date.parse("2026-09-23T12:00:00.000Z");

    await alerter.check(snapshot("3940000000"), start);
    await alerter.check(snapshot("3890000000"), start + 600_000);
    assert.equal(payloads.length, 3, "sends the initial information note and both threshold events");
    assert.match(payloads[2]!.text, /<!here>/);
    assert.match(payloads[2]!.text, /decreased by 50.000M USDC/);

    await alerter.check(snapshot("3890000000"), start + 1_200_000);
    assert.equal(payloads.length, 3, "does not remind before one hour");

    await alerter.check(snapshot("3890000000"), start + 4_200_000);
    assert.equal(payloads.length, 4, "repeats the active alert after one hour");

    await alerter.check(snapshot("3960000000"), start + 4_800_000);
    assert.equal(payloads.length, 5);
    assert.match(payloads[4]!.text, /recovered/);
  });

  it("restores the last delivery time to avoid duplicate messages after restart", async () => {
    const store = new MemoryStore();
    store.state = {
      level: "could_refill",
      lastCheckedAt: "2026-09-23T12:00:00.000Z",
      lastBalanceUsdc: "3940000000",
      lastThresholdSentAt: "2026-09-23T12:00:00.000Z",
      lastInfoSentAt: "2026-09-23T12:00:00.000Z",
    };
    let posts = 0;
    const post = async (): Promise<Response> => { posts += 1; return new Response("ok"); };
    const alerter = new SlackAlerter({
      webhookUrl: "https://hooks.slack.com/services/test",
      reminderMs: 3_600_000,
    }, store, post as typeof fetch);

    await alerter.check(snapshot("3940000000"), Date.parse("2026-09-23T12:10:00.000Z"));
    assert.equal(posts, 0);
  });

  it("sends an untagged note only when the consecutive-check drop is greater than 10M", async () => {
    const store = new MemoryStore();
    const payloads: Array<{ text: string }> = [];
    const post = async (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
      payloads.push(JSON.parse(String(init?.body)) as { text: string });
      return new Response("ok");
    };
    const alerter = new SlackAlerter({
      webhookUrl: "https://hooks.slack.com/services/test",
      reminderMs: 3_600_000,
    }, store, post as typeof fetch);
    const start = Date.parse("2026-09-23T12:00:00.000Z");

    await alerter.check(snapshot("4000000000"), start);
    await alerter.check(snapshot("3990000000"), start + 600_000);
    assert.equal(payloads.length, 1, "the first check only sends the scheduled information note");

    await alerter.check(snapshot("3979999999"), start + 1_200_000);
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
    const alerter = new SlackAlerter({
      webhookUrl: "https://hooks.slack.com/services/test",
      reminderMs: 3_600_000,
    }, store, post as typeof fetch);
    const start = Date.parse("2026-09-23T12:00:00.000Z");

    await alerter.check(snapshot("3890000000"), start);
    assert.match(payloads[0]!.text, /<!here>/);
    await alerter.check(snapshot("3879000000"), start + 600_000);
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
    const alerter = new SlackAlerter({
      webhookUrl: "https://hooks.slack.com/services/test",
      reminderMs: 3_600_000,
    }, store, post as typeof fetch);
    const start = Date.parse("2026-09-23T00:00:00.000Z");

    await alerter.check(snapshot("4000000000"), start);
    assert.equal(payloads.length, 1);
    assert.match(payloads[0]!.text, /PSM balance update/);
    assert.doesNotMatch(payloads[0]!.text, /<!here>|refill|action needed/i);

    await alerter.check(snapshot("4000000000"), start + 11 * 60 * 60 * 1_000);
    assert.equal(payloads.length, 1);

    await alerter.check(snapshot("4000000000"), start + 12 * 60 * 60 * 1_000);
    assert.equal(payloads.length, 2);
    assert.equal(store.state?.lastInfoSentAt, "2026-09-23T12:00:00.000Z");
  });
});
