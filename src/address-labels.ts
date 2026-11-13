interface LabelRow { address: string; label: string | null }
export interface CachedLabel { label: string | null; source: string | null; expiresAt: number }
export interface AddressLabelStore {
  loadAddressLabels(provider: string): Promise<{ address: string; value: CachedLabel }[]>;
  saveAddressLabel(provider: string, address: string, value: CachedLabel): Promise<void>;
}
const GENERIC_NAMES = /^(?:proxy|erc1967proxy|transparentupgradeableproxy|upgradeableproxy|beaconproxy|minimalproxy)$/i;

/** Official registries take precedence, then Arkham identity labels, then verified contract names. */
export class AddressLabels {
  private readonly cache = new Map<string, CachedLabel>();
  private readonly queued = new Set<string>();
  private readonly queue: string[] = [];
  private running: Promise<void> | undefined;
  private hydrated: Promise<void> | undefined;
  private arkhamUnavailableUntil = 0;

  constructor(private readonly apiKey = process.env.ETHERSCAN_API_KEY,
    private readonly request: typeof fetch = fetch,
    private readonly pause = () => new Promise<void>(resolve => { setTimeout(resolve, 650).unref(); }),
    private readonly arkhamKey = process.env.ARKM_API_KEY,
    private readonly store?: AddressLabelStore) {}

  async warm(rows: LabelRow[]): Promise<void> {
    if (!this.apiKey && !this.arkhamKey) return;
    this.hydrated ??= this.hydrate();
    await this.hydrated;
    for (const row of rows) {
      const address = row.address.toLowerCase();
      if (row.label || (this.cache.get(address)?.expiresAt ?? 0) > Date.now() || this.queued.has(address)) continue;
      this.queued.add(address); this.queue.push(address);
    }
    if (!this.queue.length) return this.running ?? Promise.resolve();
    this.running ??= this.drain().finally(() => { this.running = undefined; });
    return this.running;
  }

  loading(rows: LabelRow[]): boolean {
    if (!this.apiKey && !this.arkhamKey) return false;
    return rows.some(row => {
      const address = row.address.toLowerCase();
      return !row.label && (this.queued.has(address) || (this.cache.get(address)?.expiresAt ?? 0) <= Date.now());
    });
  }

  decorate<T extends LabelRow>(rows: T[]) {
    return rows.map(row => {
      if (row.label) return { ...row, labelSource: "official registry" };
      const cached = this.cache.get(row.address.toLowerCase());
      const label = cached && cached.expiresAt > Date.now() ? cached.label : null;
      return { ...row, label, labelSource: label ? cached!.source : null };
    });
  }

  private async drain(): Promise<void> {
    while (this.queue.length) {
      const address = this.queue.shift()!;
      try {
        let label: string | null = null, source: string | null = null, failed = false, arkhamFailed = false;
        if (this.arkhamKey) {
          try { label = await this.arkhamLabel(address); if (label) source = "Arkham"; }
          catch { failed = true; arkhamFailed = true; }
        }
        if (!label && this.apiKey) {
          try { label = await this.contractLabel(address); if (label) source = "Etherscan verified contract name"; }
          catch { failed = true; }
        }
        const previous = this.cache.get(address);
        if (previous?.label && ((arkhamFailed && previous.source === "Arkham") || (failed && !label))) {
          label = previous.label; source = previous.source;
        }
        const value = { label, source, expiresAt: Date.now() + (failed ? 5 * 60_000 : 24 * 60 * 60_000) };
        this.cache.set(address, value);
        try { await this.store?.saveAddressLabel(this.provider, address, value); } catch { /* Memory cache remains usable. */ }
      } catch {
        // Never expose provider errors, which can include credentials.
        this.cache.set(address, { label: null, source: null, expiresAt: Date.now() + 5 * 60_000 });
      } finally { this.queued.delete(address); }
      if (this.queue.length) await this.pause();
    }
  }
  private get provider(): string { return this.arkhamKey ? "arkham-v1" : "etherscan-v1"; }

  private async hydrate(): Promise<void> {
    try {
      for (const row of await this.store?.loadAddressLabels(this.provider) ?? []) {
        this.cache.set(row.address.toLowerCase(), row.value);
      }
    } catch { /* Provider lookup can proceed if persistent cache is unavailable. */ }
  }

  private async arkhamLabel(address: string): Promise<string | null> {
    if (Date.now() < this.arkhamUnavailableUntil) throw new Error("Label lookup paused");
    const response = await this.request(`https://api.arkm.com/intelligence/address/${address}?chain=ethereum`, {
      headers: { "API-Key": this.arkhamKey! }, signal: AbortSignal.timeout(8_000),
    });
    if (!response.ok) {
      if ([401, 403, 429].includes(response.status)) {
        const retry = response.headers.get("retry-after");
        const delay = retry && Number.isFinite(Number(retry)) ? Number(retry) * 1000 : retry ? Date.parse(retry) - Date.now() : 0;
        this.arkhamUnavailableUntil = Date.now() + Math.max(response.status === 429 ? 60_000 : 30 * 60_000, Number.isFinite(delay) ? delay : 0);
      }
      await response.body?.cancel();
      throw new Error("Label service unavailable");
    }
    const body = await response.json() as { address?: string; chain?: string; arkhamEntity?: { name?: unknown }; arkhamLabel?: { name?: unknown } };
    if (body.address?.toLowerCase() !== address || body.chain !== "ethereum") throw new Error("Label response does not match address");
    const entity = typeof body.arkhamEntity?.name === "string" ? body.arkhamEntity.name.trim() : "";
    const name = typeof body.arkhamLabel?.name === "string" ? body.arkhamLabel.name.trim() : "";
    return (entity && name && !name.toLowerCase().includes(entity.toLowerCase()) ? `${entity}: ${name}` : name || entity).slice(0, 180) || null;
  }

  private async contractLabel(address: string): Promise<string | null> {
    const url = new URL("https://api.etherscan.io/v2/api");
    url.search = new URLSearchParams({ chainid: "1", module: "contract", action: "getsourcecode", address, apikey: this.apiKey! }).toString();
    const response = await this.request(url, { signal: AbortSignal.timeout(8_000) });
    if (!response.ok) throw new Error("Label service unavailable");
    const body = await response.json() as { status?: string; result?: { ContractName?: unknown }[] | string };
    if (body.status !== "1" || !Array.isArray(body.result)) throw new Error("Label service unavailable");
    const value = body.result[0]?.ContractName;
    const name = typeof value === "string" ? value.trim() : "";
    return name && !GENERIC_NAMES.test(name) ? `Contract: ${name.slice(0, 120)}` : null;
  }

}
