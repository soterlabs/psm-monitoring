import { decodeEventLog, formatUnits, getAddress, parseAbiItem, toEventSelector, type PublicClient } from "viem";
import { findBlockNearTimestamp } from "./chain.js";
import type { Config } from "./config.js";
import { safeErrorMessage } from "./errors.js";

export const withdrawalRanges = ["1d", "7d", "30d", "90d", "180d"] as const;
export type WithdrawalRange = typeof withdrawalRanges[number];
export const buyGemEvent = parseAbiItem("event BuyGem(address indexed owner, uint256 value, uint256 fee)");
export const buyGemTopic = toEventSelector(buyGemEvent);
export const transferEvent = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 value)");
export const transferTopic = toEventSelector(transferEvent);
export const canonicalPocket = "0x37305b1cd40574e4c5ce33f8e8306be057fd7341";
export const canonicalUsdc = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
export const usdsWrapper = "0xa188eec8f81263234da3622a406892f3d630f98c";

// Ethereum registries, checked 2026-11-06. Keep different proxies as separate addresses.
// https://github.com/sparkdotfi/spark-address-registry/blob/master/src/Ethereum.sol
// https://github.com/grove-labs/grove-address-registry/blob/master/src/Ethereum.sol
export const withdrawalLabels: Record<string, string> = {
  "0x1601843c5e9bc251a3272907010afa41fa18347e": "Spark ALM Proxy",
  "0xe5c6318456a7cb6f74f93b4eee4616db5fcef699": "Spark ALM Proxy (freezable)",
  "0x8d719a830b00e5571db00d173505cd56c0ec224a": "Spark spUSDC ALM Proxy",
  "0x491edfb0b8b608044e227225c715981a30f3a44e": "Grove ALM Proxy",
  "0x0dcd9298e163dfd3c0b5b00f0d9093c36e40a153": "Grove Diamond PAU Proxy",
};

export interface WithdrawalEvent {
  txHash: string;
  logIndex: number;
  blockNumber: number;
  timestamp: string;
  recipient: string;
  amountRaw: string;
}
export interface WithdrawalIndexState {
  startBlock: number;
  startTimestamp: string;
  nextBlock: number;
  targetBlock: number;
  throughTimestamp: string;
  updatedAt: string;
  throughBlock?: number;
  headUpdatedAt?: string;
  mode?: "head" | "backfill";
  pendingStartBlock?: number;
  pendingStartTimestamp?: string;
}
export interface WithdrawalTotal { address: string; amountRaw: string; withdrawnRaw: string; replenishedRaw: string; swaps: number }
export interface WithdrawalStorage {
  load(psm: string): Promise<WithdrawalIndexState | undefined>;
  savePage(psm: string, expectedNextBlock: number | undefined, events: WithdrawalEvent[], state: WithdrawalIndexState): Promise<void>;
  totals(psm: string, from: string, through: string): Promise<WithdrawalTotal[]>;
  close(): Promise<void>;
}

export class MemoryWithdrawalStorage implements WithdrawalStorage {
  private readonly states = new Map<string, WithdrawalIndexState>();
  private readonly events = new Map<string, Map<string, WithdrawalEvent>>();
  async load(psm: string): Promise<WithdrawalIndexState | undefined> { return this.states.get(psm); }
  async savePage(psm: string, expected: number | undefined, events: WithdrawalEvent[], state: WithdrawalIndexState): Promise<void> {
    if (this.states.get(psm)?.nextBlock !== expected) return;
    const stored = this.events.get(psm) ?? new Map<string, WithdrawalEvent>();
    for (const event of events) stored.set(`${event.txHash}:${event.logIndex}:${event.recipient}`, event);
    this.events.set(psm, stored);
    this.states.set(psm, state);
  }
  async totals(psm: string, from: string, through: string): Promise<WithdrawalTotal[]> {
    const totals = new Map<string, { amount: bigint; withdrawn: bigint; replenished: bigint; swaps: number }>();
    for (const event of this.events.get(psm)?.values() ?? []) {
      if (event.timestamp < from || event.timestamp > through) continue;
      const total = totals.get(event.recipient) ?? { amount: 0n, withdrawn: 0n, replenished: 0n, swaps: 0 };
      const amount = BigInt(event.amountRaw);
      total.amount += amount;
      if (amount > 0n) total.withdrawn += amount; else total.replenished -= amount;
      total.swaps++;
      totals.set(event.recipient, total);
    }
    return [...totals].filter(([, total]) => total.amount > 0n).map(([address, total]) => ({ address, amountRaw: total.amount.toString(), withdrawnRaw: total.withdrawn.toString(), replenishedRaw: total.replenished.toString(), swaps: total.swaps }))
      .sort(compareWithdrawalTotals).slice(0, 20);
  }
  async close(): Promise<void> {}
}

export function compareWithdrawalTotals(a: WithdrawalTotal, b: WithdrawalTotal): number {
  const difference = BigInt(b.amountRaw) - BigInt(a.amountRaw);
  return difference > 0n ? 1 : difference < 0n ? -1 : a.address.localeCompare(b.address);
}

interface IndexedLog {
  address: string; block_number: number; transaction_hash: string; log_index: number;
  topic0: `0x${string}`; topic1: `0x${string}`; topic2?: `0x${string}`; data: `0x${string}`;
}
export interface WithdrawalPage {
  next_block: number;
  data: { blocks: { number: number; timestamp: number | string; hash: string }[]; logs: IndexedLog[] }[];
}

export function decodeWithdrawalPage(page: WithdrawalPage, psm: string, from: number, to: number, pocket = canonicalPocket, usdc = canonicalUsdc): WithdrawalEvent[] {
  if (!Number.isSafeInteger(page.next_block) || page.next_block <= from || page.next_block > to + 1) {
    throw new Error("Withdrawal index returned an invalid pagination cursor");
  }
  const timestamps = new Map(page.data.flatMap(group => group.blocks).map(b => [b.number, new Date(Number(b.timestamp) * 1000).toISOString()]));
  const reserves = new Set([psm.toLowerCase(), pocket.toLowerCase()]);
  const transactions = new Map<string, IndexedLog[]>();
  const seen = new Set<string>();
  for (const log of page.data.flatMap(group => group.logs)) {
    if (log.address.toLowerCase() !== usdc.toLowerCase() || log.topic0 !== transferTopic) continue;
    if (log.block_number < from || log.block_number >= page.next_block) throw new Error("USDC flow outside indexed range");
    const key = `${log.transaction_hash}:${log.log_index}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const logs = transactions.get(log.transaction_hash) ?? [];
    logs.push(log); transactions.set(log.transaction_hash, logs);
  }
  const rows: WithdrawalEvent[] = [];
  for (const logs of transactions.values()) {
    // The canonical wrapper pulls USDC from its caller immediately before forwarding it.
    // Attribute those deposits to the funding caller using chronological token lots.
    const wrapperFunds: { address: string; amount: bigint }[] = [];
    for (const log of logs.sort((a, b) => a.log_index - b.log_index)) {
      const timestamp = timestamps.get(log.block_number);
      if (!timestamp) throw new Error("USDC flow is missing its block timestamp");
      if (!log.topic2) throw new Error("USDC transfer is missing its recipient");
      const decoded = decodeEventLog({ abi: [transferEvent], topics: [log.topic0, log.topic1, log.topic2], data: log.data, strict: true });
      const src = decoded.args.from.toLowerCase(), dst = decoded.args.to.toLowerCase(), amount = decoded.args.value;
      if (!amount) continue;
      let lots = [{ address: src, amount }];
      if (src === usdsWrapper) {
        lots = []; let remaining = amount;
        while (remaining && wrapperFunds.length) {
          const first = wrapperFunds[0]!, used = remaining < first.amount ? remaining : first.amount;
          lots.push({ address: first.address, amount: used }); remaining -= used; first.amount -= used;
          if (!first.amount) wrapperFunds.shift();
        }
        if (remaining) lots.push({ address: src, amount: remaining });
      }
      if (dst === usdsWrapper) wrapperFunds.push(...lots.map(lot => ({ ...lot, address: reserves.has(src) ? usdsWrapper : lot.address })));
      if (reserves.has(src) === reserves.has(dst)) continue;
      const amounts = new Map<string, bigint>();
      if (reserves.has(src)) amounts.set(dst, amount);
      else for (const lot of lots) amounts.set(lot.address, (amounts.get(lot.address) ?? 0n) - lot.amount);
      for (const [recipient, value] of amounts) rows.push({ txHash: log.transaction_hash.toLowerCase(), logIndex: log.log_index,
        blockNumber: log.block_number, timestamp, recipient, amountRaw: value.toString() });
    }
  }
  return rows;
}

export async function fetchWithdrawalPage(psm: string, from: number, to: number, pocket: string, usdc: string): Promise<WithdrawalPage> {
  const token = process.env.ENVIO_API_TOKEN;
  if (!token) throw new Error("Withdrawal indexing requires ENVIO_API_TOKEN");
  const request: RequestInit = {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({
      from_block: from, to_block: to + 1,
      logs: [
        { address: [usdc.toLowerCase()], topics: [[transferTopic], [psm, pocket, usdsWrapper].map(a => "0x" + a.toLowerCase().slice(2).padStart(64, "0"))] },
        { address: [usdc.toLowerCase()], topics: [[transferTopic], [], [psm, pocket, usdsWrapper].map(a => "0x" + a.toLowerCase().slice(2).padStart(64, "0"))] },
      ],
      join_mode: "Default",
      field_selection: {
        block: ["number", "timestamp", "hash"],
        log: ["address", "block_number", "transaction_hash", "log_index", "topic0", "topic1", "topic2", "data"],
        transaction: [],
      },
      max_num_logs: 25_000, max_num_blocks: 25_000, max_num_transactions: 100_000,
    }),
  };
  for (let attempt = 0; attempt < 3; attempt++) {
    const response = await fetch("https://eth.hypersync.xyz/query", { ...request, signal: AbortSignal.timeout(25_000) });
    if (response.status === 429 && attempt < 2) {
      const seconds = Number(response.headers.get("retry-after") ?? attempt + 1);
      await response.body?.cancel();
      await new Promise(resolve => setTimeout(resolve, Math.min(5, Math.max(1, Number.isFinite(seconds) ? seconds : 1)) * 1000));
      continue;
    }
    if (!response.ok) throw new Error(`Withdrawal index request failed (${response.status})`);
    return await response.json() as WithdrawalPage;
  }
  throw new Error("Withdrawal index rate limited");
}

export class WithdrawalMonitor {
  lastError: { message: string; at: string } | undefined;
  private refreshing: Promise<void> | undefined;
  private reservePocket: string | undefined;
  constructor(private readonly client: PublicClient, private readonly config: Config,
    readonly storage: WithdrawalStorage = new MemoryWithdrawalStorage(),
    private readonly fetchPage = fetchWithdrawalPage) {}

  // One bounded page per request; incomplete backfills are never presented as rankings.
  async refresh(): Promise<void> {
    this.refreshing ??= this.syncPage().then(() => { this.lastError = undefined; }, error => {
      this.lastError = { message: safeErrorMessage(error), at: new Date().toISOString() };
      throw error;
    }).finally(() => { this.refreshing = undefined; });
    return this.refreshing;
  }

  private async syncPage(): Promise<void> {
    let state = await this.storage.load(this.config.psmAddress.toLowerCase());
    const expected = state?.nextBlock;
    const headFresh = state && Date.now() - Date.parse(state.headUpdatedAt ?? state.updatedAt) < 5 * 60_000;
    const has180Days = state && Date.parse(state.startTimestamp) <= Date.parse(state.throughTimestamp) - 180 * 86400_000;
    if (state && state.nextBlock > state.targetBlock && headFresh && has180Days) return;
    if (!state || state.nextBlock > state.targetBlock) {
      if (!state || !headFresh) {
        if (await this.client.getChainId() !== 1) throw new Error("Withdrawal indexing requires Ethereum mainnet RPC");
        const latest = await this.client.getBlock({ blockTag: "finalized" });
        const throughTimestamp = new Date(Number(latest.timestamp) * 1000).toISOString();
        if (!state) {
          const first = await findBlockNearTimestamp(this.client, latest.timestamp - 86400n - 3600n, latest);
          if (first.timestamp > latest.timestamp - 86400n) throw new Error("Unable to establish complete withdrawal coverage");
          state = { startBlock: Number(latest.number) + 1, startTimestamp: new Date(Number(latest.timestamp) * 1000 + 1).toISOString(),
            nextBlock: Number(first.number), targetBlock: Number(latest.number), throughTimestamp,
            throughBlock: Number(latest.number), headUpdatedAt: new Date().toISOString(), updatedAt: new Date().toISOString(), mode: "head",
            pendingStartBlock: Number(first.number), pendingStartTimestamp: new Date(Number(first.timestamp) * 1000).toISOString() };
        } else {
          const throughBlock = state.throughBlock ?? state.nextBlock - 1;
          if (throughBlock >= Number(latest.number)) return;
          state = { ...state, nextBlock: throughBlock + 1, targetBlock: Number(latest.number), mode: "head",
            pendingStartBlock: state.startBlock, pendingStartTimestamp: state.startTimestamp };
        }
      } else {
        // Make 7d and 30d available first, then expand in bounded 30-day chunks.
        const asOf = BigInt(Math.floor(Date.parse(state.throughTimestamp) / 1000));
        const coveredDays = (asOf - BigInt(Math.floor(Date.parse(state.startTimestamp) / 1000))) / 86400n;
        const nextDays = coveredDays < 7n ? 7n : coveredDays < 30n ? 30n : coveredDays + 30n > 180n ? 180n : coveredDays + 30n;
        const target = asOf - nextDays * 86400n - 3600n;
        const latest = { number: BigInt(state.throughBlock ?? state.targetBlock), timestamp: BigInt(Math.floor(Date.parse(state.throughTimestamp) / 1000)) };
        const first = await findBlockNearTimestamp(this.client, target, latest);
        if (Number(first.number) >= state.startBlock) throw new Error("Withdrawal backfill did not move backwards");
        state = { ...state, nextBlock: Number(first.number), targetBlock: state.startBlock - 1, mode: "backfill",
          pendingStartBlock: Number(first.number), pendingStartTimestamp: new Date(Number(first.timestamp) * 1000).toISOString() };
      }
    }
    if (!this.reservePocket) {
      const [pocket, gem] = await Promise.all([
        this.client.readContract({ address: this.config.psmAddress, abi: [parseAbiItem("function pocket() view returns (address)")], functionName: "pocket" }),
        this.client.readContract({ address: this.config.psmAddress, abi: [parseAbiItem("function gem() view returns (address)")], functionName: "gem" }),
      ]);
      if (getAddress(gem) !== this.config.usdcAddress) throw new Error("PSM flow token differs from configured USDC");
      this.reservePocket = pocket.toLowerCase();
    }
    const page = await this.fetchPage(this.config.psmAddress, state.nextBlock, state.targetBlock, this.reservePocket, this.config.usdcAddress);
    const events = decodeWithdrawalPage(page, this.config.psmAddress, state.nextBlock, state.targetBlock, this.reservePocket, this.config.usdcAddress);
    const through = await this.client.getBlock({ blockNumber: BigInt(page.next_block - 1) });
    const indexed = page.data.flatMap(group => group.blocks).find(b => b.number === Number(through.number));
    if (indexed && indexed.hash.toLowerCase() !== through.hash.toLowerCase()) throw new Error("Withdrawal index block hash differs from Ethereum RPC");
    const complete = page.next_block > state.targetBlock;
    const now = new Date().toISOString();
    await this.storage.savePage(this.config.psmAddress.toLowerCase(), expected, events, {
      ...state, nextBlock: page.next_block, updatedAt: now,
      ...(complete ? { startBlock: state.pendingStartBlock ?? state.startBlock, startTimestamp: state.pendingStartTimestamp ?? state.startTimestamp } : {}),
      ...(complete && state.mode === "head" ? { throughBlock: Number(through.number), throughTimestamp: new Date(Number(through.timestamp) * 1000).toISOString(), headUpdatedAt: now } : {}),
    });
  }

  async result(range: WithdrawalRange) {
    const state = await this.storage.load(this.config.psmAddress.toLowerCase());
    const asOf = state?.throughTimestamp;
    const from = asOf ? new Date(Date.parse(asOf) - Number(range.slice(0, -1)) * 86400_000).toISOString() : undefined;
    const covered = from && state && state.startTimestamp <= from;
    const rows = covered ? await this.storage.totals(this.config.psmAddress.toLowerCase(), from, asOf!) : [];
    return {
      range, complete: Boolean(covered), asOf: asOf ?? null, from: from ?? null,
      indexedPercent: state ? Math.min(100, Math.max(0, (Date.parse(state.throughTimestamp) - Date.parse(state.startTimestamp)) / (Number(range.slice(0, -1)) * 86400_000) * 100)) : 0,
      attribution: "Net USDC withdrawn minus replenished per reserve counterparty. Canonical USDS wrapper deposits credited to their funding caller; other routers can represent multiple users.",
      rows: rows.map((row, index) => ({ rank: index + 1, address: getAddress(row.address), label: withdrawalLabels[row.address.toLowerCase()] ?? null,
        netWithdrawnUsdc: formatUnits(BigInt(row.amountRaw), 6), withdrawnUsdc: formatUnits(BigInt(row.withdrawnRaw), 6), replenishedUsdc: formatUnits(BigInt(row.replenishedRaw), 6), swaps: row.swaps, etherscanUrl: `https://etherscan.io/address/${row.address}` })),
    };
  }
}

// Cached windows stay usable while older history is indexed. Initial requests have
// a bounded wait; refresh errors are captured even when the response returns first.
export async function withdrawalResponse(monitor: WithdrawalMonitor, range: WithdrawalRange, waitMs = 8_000) {
  const cached = await monitor.result(range);
  const refresh = monitor.refresh().catch(() => undefined);
  if (!cached.complete) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([refresh, new Promise<void>(resolve => { timer = setTimeout(resolve, waitMs); })]);
    } finally { if (timer) clearTimeout(timer); }
  }
  const snapshot = cached.complete ? cached : await monitor.result(range);
  const error = monitor.lastError ? { message: monitor.lastError.message } : null;
  return { status: snapshot.complete ? 200 : error ? 503 : 202, body: { snapshot, error } };
}
