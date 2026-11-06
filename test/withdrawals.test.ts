import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { encodeAbiParameters, encodeEventTopics, type PublicClient } from "viem";
import { loadConfig } from "../src/config.js";
import { transferEvent, transferTopic, canonicalPocket, canonicalUsdc, usdsWrapper, compareWithdrawalTotals, decodeWithdrawalPage, MemoryWithdrawalStorage, WithdrawalMonitor, type WithdrawalEvent, type WithdrawalIndexState, type WithdrawalPage } from "../src/withdrawals.js";

function testConfig() {
  const previous = process.env.ETH_RPC;
  process.env.ETH_RPC = "https://example.com";
  try { return loadConfig(); }
  finally { if (previous === undefined) delete process.env.ETH_RPC; else process.env.ETH_RPC = previous; }
}

const psm = "0xf6e72db5454dd049d0788e411b06cfaf16853042";
const owner = "0x1601843c5e9bc251a3272907010afa41fa18347e";
const timestamp = "2026-11-06T12:00:00.000Z";
const state: WithdrawalIndexState = { startBlock: 1, startTimestamp: "2026-01-01T00:00:00.000Z", nextBlock: 101, targetBlock: 100, throughTimestamp: timestamp, updatedAt: timestamp };
const event = (amount: string, extra: Partial<WithdrawalEvent> = {}): WithdrawalEvent => ({ txHash: "0xabc", logIndex: 1, blockNumber: 100, timestamp, recipient: owner, amountRaw: amount, ...extra });

function page(amount = 123456789n, from: `0x${string}` = canonicalPocket, to: `0x${string}` = owner): WithdrawalPage {
  const topics = encodeEventTopics({ abi: [transferEvent], eventName: "Transfer", args: { from, to } });
  return { next_block: 101, data: [{ blocks: [{ number: 100, timestamp: Date.parse(timestamp) / 1000, hash: "0x123" }], logs: [{
    address: canonicalUsdc, block_number: 100, transaction_hash: "0xabc", log_index: 1, topic0: transferTopic,
    topic1: topics[1] as `0x${string}`, topic2: topics[2] as `0x${string}`,
    data: encodeAbiParameters([{ type: "uint256" }], [amount]),
  }] }] };
}

describe("PSM withdrawal attribution and accounting", () => {
  it("attributes reserve USDC outflows to their recipient", () => {
    const rows = decodeWithdrawalPage(page(), psm, 90, 100);
    assert.equal(rows[0]?.recipient, owner);
    assert.equal(rows[0]?.amountRaw, "123456789");
  });
  it("deduplicates logs and ignores zero-amount swaps", () => {
    const p = page(); p.data[0]!.logs.push(p.data[0]!.logs[0]!);
    assert.equal(decodeWithdrawalPage(p, psm, 90, 100).length, 1);
    assert.equal(decodeWithdrawalPage(page(0n), psm, 90, 100).length, 0);
  });
  it("credits direct replenishments to the USDC payer and ignores internal reserve transfers", () => {
    assert.equal(decodeWithdrawalPage(page(100n, owner, canonicalPocket), psm, 90, 100)[0]?.amountRaw, "-100");
    assert.deepEqual(decodeWithdrawalPage(page(100n, canonicalPocket, psm), psm, 90, 100), []);
  });
  it("credits wrapper replenishments to their funding address, not the wrapper", () => {
    const p = page(200n);
    const funding = page(150n, owner, usdsWrapper).data[0]!.logs[0]!;
    const deposit = page(150n, usdsWrapper, canonicalPocket).data[0]!.logs[0]!;
    p.data[0]!.logs.push({ ...funding, log_index: 2 }, { ...deposit, log_index: 3 });
    const rows = decodeWithdrawalPage(p, psm, 90, 100);
    assert.deepEqual(rows.map(r => [r.recipient, r.amountRaw]), [[owner, "200"], [owner, "-150"]]);
    assert.equal(rows.reduce((sum, r) => sum + BigInt(r.amountRaw), 0n), 50n);
  });
  it("splits a wrapper deposit across funders while preserving the reserve flow total", () => {
    const second = "0x491edfb0b8b608044e227225c715981a30f3a44e";
    const p = page(100n, owner, usdsWrapper);
    p.data[0]!.logs.push({ ...page(200n, second, usdsWrapper).data[0]!.logs[0]!, log_index: 2 },
      { ...page(300n, usdsWrapper, canonicalPocket).data[0]!.logs[0]!, log_index: 3 });
    assert.deepEqual(decodeWithdrawalPage(p, psm, 90, 100).map(r => [r.recipient, r.amountRaw]), [[owner, "-100"], [second, "-200"]]);
  });
  it("ranks by net amounts and excludes fully replenished and net-supplying addresses", async () => {
    const storage = new MemoryWithdrawalStorage();
    const rows = [event("100", { txHash: "a" }), event("-99", { txHash: "b" }),
      event("10", { txHash: "c", recipient: "other" }), event("900", { txHash: "d", recipient: "neutral" }),
      event("-900", { txHash: "e", recipient: "neutral" }), event("-1000", { txHash: "f", recipient: "supplier" })];
    await storage.savePage(psm, undefined, rows, state);
    const totals = await storage.totals(psm, timestamp, timestamp);
    assert.deepEqual(totals.map(t => [t.address, t.amountRaw]), [["other", "10"], [owner, "1"]]);
    assert.equal(totals[1]?.withdrawnRaw, "100"); assert.equal(totals[1]?.replenishedRaw, "99");
  });
  it("rejects incomplete metadata, foreign events and invalid cursors", () => {
    const p = page(); p.data[0]!.blocks = [];
    assert.throws(() => decodeWithdrawalPage(p, psm, 90, 100), /timestamp/);
    const outside = page(); outside.data[0]!.logs[0]!.block_number = 89;
    assert.throws(() => decodeWithdrawalPage(outside, psm, 90, 100), /range/);
    assert.throws(() => decodeWithdrawalPage({ ...page(), next_block: 90 }, psm, 90, 100), /cursor/);
    assert.throws(() => decodeWithdrawalPage({ ...page(), next_block: 102 }, psm, 90, 100), /cursor/);
  });
  it("sorts micro-USDC exactly even above Number's safe integer range", () => {
    const rows = [{ address: "a", withdrawnRaw: "0", replenishedRaw: "0", amountRaw: "999999999999999999", swaps: 1 }, { address: "b", withdrawnRaw: "0", replenishedRaw: "0", amountRaw: "1000000000000000000", swaps: 1 }];
    assert.equal(rows.sort(compareWithdrawalTotals)[0]?.address, "b");
  });
  it("aggregates gross payouts, uses exact rolling boundaries and limits to 20", async () => {
    const storage = new MemoryWithdrawalStorage();
    const rows = Array.from({ length: 25 }, (_, i) => event(String(i + 1), { txHash: String(i), recipient: `address${i}` }));
    rows.push(event("100", { txHash: "duplicate-recipient", recipient: "address0" }));
    rows.push(event("9999", { txHash: "before", timestamp: "2026-11-05T11:59:59.000Z" }));
    rows.push(event("1", { txHash: "boundary", timestamp: "2026-11-05T12:00:00.000Z", recipient: "address0" }));
    rows.push(event("99999", { txHash: "after", timestamp: "2026-11-06T12:00:01.000Z" }));
    await storage.savePage(psm, undefined, rows, state);
    const totals = await storage.totals(psm, "2026-11-05T12:00:00.000Z", timestamp);
    assert.equal(totals.length, 20); assert.equal(totals[0]?.address, "address0"); assert.equal(totals[0]?.amountRaw, "102");
    assert.equal(totals[0]?.swaps, 3);
    await storage.savePage(psm, undefined, [event("999999")], state); // Stale worker cannot replay or advance.
    assert.deepEqual(await storage.totals(psm, "2026-11-05T12:00:00.000Z", timestamp), totals);
  });
  it("does not show partial backfill totals as a complete ranking", async () => {
    const storage = new MemoryWithdrawalStorage();
    await storage.savePage(psm, undefined, [event("1000000")], { ...state, nextBlock: 100, startTimestamp: "2026-11-06T12:00:01.000Z" });
    const config = testConfig();
    const monitor = new WithdrawalMonitor({} as PublicClient, config, storage);
    const result = await monitor.result("7d");
    assert.equal(result.complete, false); assert.deepEqual(result.rows, []);
  });
  it("returns address labels, exact amounts, and complete empty periods", async () => {
    const storage = new MemoryWithdrawalStorage();
    await storage.savePage(psm, undefined, [event("123456789")], state);
    const config = testConfig();
    const monitor = new WithdrawalMonitor({} as PublicClient, config, storage);
    const result = await monitor.result("7d");
    assert.equal(result.complete, true); assert.equal(result.rows[0]?.label, "Spark ALM Proxy");
    assert.equal(result.rows[0]?.netWithdrawnUsdc, "123.456789");
    const empty = new MemoryWithdrawalStorage(); await empty.savePage(psm, undefined, [], state);
    assert.equal((await new WithdrawalMonitor({} as PublicClient, config, empty).result("180d")).complete, true);
  });
  it("resumes pages after restart and extends recent coverage backwards without moving asOf", async () => {
    const storage = new MemoryWithdrawalStorage();
    const height = 3_000_000n, time = 1_794_000_000n;
    const client = { readContract: async ({functionName}: {functionName:string}) => functionName === "gem" ? canonicalUsdc : canonicalPocket, getChainId: async () => 1, getBlock: async ({ blockNumber }: { blockNumber?: bigint }) => {
      const number = blockNumber ?? height;
      return { number, timestamp: time - (height - number) * 12n, hash: "0x123" };
    } } as unknown as PublicClient;
    let calls = 0;
    const fetchPage = async (_psm: string, from: number, to: number): Promise<WithdrawalPage> => {
      calls++;
      return { next_block: calls === 1 ? from + 100 : to + 1, data: [] };
    };
    const config = testConfig();
    let monitor = new WithdrawalMonitor(client, config, storage, fetchPage);
    await monitor.refresh();
    assert.equal((await monitor.result("1d")).complete, false);
    monitor = new WithdrawalMonitor(client, config, storage, fetchPage);
    await monitor.refresh();
    const first = await monitor.result("1d");
    assert.equal(first.complete, true);
    assert.equal((await monitor.result("7d")).complete, false);
    await monitor.refresh();
    assert.equal((await monitor.result("7d")).complete, true);
    assert.equal((await monitor.result("30d")).complete, false);
    await monitor.refresh();
    assert.equal((await monitor.result("30d")).complete, true);
    assert.equal((await monitor.result("90d")).complete, false);
    assert.equal((await monitor.result("1d")).asOf, first.asOf);
    for (let i = 0; i < 5; i++) await monitor.refresh();
    assert.equal((await monitor.result("180d")).complete, true);
    const before = calls;
    await monitor.refresh();
    assert.equal(calls, before);
  });
});
