interface LabelRow { address: string; label: string | null }
interface CachedLabel { label: string | null; expiresAt: number }
const GENERIC_NAMES = /^(?:proxy|erc1967proxy|transparentupgradeableproxy|upgradeableproxy|beaconproxy|minimalproxy)$/i;

/** Contract names are code metadata, not public identity tags. Registry labels take precedence. */
export class AddressLabels {
  private readonly cache = new Map<string, CachedLabel>();
  private readonly queued = new Set<string>();
  private readonly queue: string[] = [];
  private running: Promise<void> | undefined;

  constructor(private readonly apiKey = process.env.ETHERSCAN_API_KEY,
    private readonly request: typeof fetch = fetch,
    private readonly pause = () => new Promise<void>(resolve => { setTimeout(resolve, 650).unref(); })) {}

  warm(rows: LabelRow[]): Promise<void> {
    if (!this.apiKey) return Promise.resolve();
    for (const row of rows) {
      const address = row.address.toLowerCase();
      if (row.label || (this.cache.get(address)?.expiresAt ?? 0) > Date.now() || this.queued.has(address)) continue;
      this.queued.add(address); this.queue.push(address);
    }
    if (!this.queue.length) return this.running ?? Promise.resolve();
    this.running ??= this.drain().finally(() => { this.running = undefined; });
    return this.running;
  }

  loading(rows: LabelRow[]): boolean { return rows.some(row => this.queued.has(row.address.toLowerCase())); }

  decorate<T extends LabelRow>(rows: T[]) {
    return rows.map(row => {
      if (row.label) return { ...row, labelSource: "official registry" };
      const cached = this.cache.get(row.address.toLowerCase());
      const label = cached && cached.expiresAt > Date.now() ? cached.label : null;
      return { ...row, label, labelSource: label ? "Etherscan verified contract name" : null };
    });
  }

  private async drain(): Promise<void> {
    while (this.queue.length) {
      const address = this.queue.shift()!;
      try {
        const url = new URL("https://api.etherscan.io/v2/api");
        url.search = new URLSearchParams({ chainid: "1", module: "contract", action: "getsourcecode", address, apikey: this.apiKey! }).toString();
        const response = await this.request(url, { signal: AbortSignal.timeout(8_000) });
        if (!response.ok) throw new Error("Label service unavailable");
        const body = await response.json() as { status?: string; result?: { ContractName?: unknown }[] | string };
        if (body.status !== "1" || !Array.isArray(body.result)) throw new Error("Label service unavailable");
        const value = body.result[0]?.ContractName;
        const name = typeof value === "string" ? value.trim() : "";
        const label = name && !GENERIC_NAMES.test(name) ? `Contract: ${name.slice(0, 120)}` : null;
        this.cache.set(address, { label, expiresAt: Date.now() + 24 * 60 * 60_000 });
      } catch {
        // Provider errors can contain a key-bearing URL. Never log or return them.
        this.cache.set(address, { label: null, expiresAt: Date.now() + 5 * 60_000 });
      } finally { this.queued.delete(address); }
      if (this.queue.length) await this.pause();
    }
  }
}
