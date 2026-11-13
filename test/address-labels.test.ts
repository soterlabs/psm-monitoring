import assert from "node:assert/strict";
import { it } from "node:test";
import { AddressLabels } from "../src/address-labels.js";
import type { AddressLabelStore, CachedLabel } from "../src/address-labels.js";
import { SnapshotStore } from "../src/database.js";
import { Pool } from "pg";
import { randomBytes } from "node:crypto";

const one = { address: "0x958A0904940f744f8c6b72c043CeeE3EA34AE888", label: null };
const two = { address: "0xD00e0079B8CAB524F3fa20EA879a7736E512a5Fc", label: null };
const registry = { address: "0x1601843c5E9bC251A3272907010AFa41Fa18347E", label: "Spark ALM Proxy" };
const result = (name: string) => Response.json({ status: "1", result: [{ ContractName: name }] });

it("keeps registry identities and distinguishes verified contract names from owner labels", async () => {
  const urls: URL[] = [];
  const request = (async input => { urls.push(new URL(String(input))); return result("LitePSMAggregator"); }) as typeof fetch;
  const labels = new AddressLabels("test-key", request, async () => {}, "");
  await labels.warm([registry, one]);
  const rows = labels.decorate([registry, one]);
  assert.equal(urls.length, 1); assert.equal(urls[0]?.searchParams.get("address"), one.address.toLowerCase());
  assert.equal(rows[0]?.label, "Spark ALM Proxy"); assert.equal(rows[0]?.labelSource, "official registry");
  assert.equal(rows[1]?.label, "Contract: LitePSMAggregator");
  await labels.warm([one]); assert.equal(urls.length, 1);
});

it("leaves unverified and generic proxy contracts unlabeled", async () => {
  let count = 0;
  const request = (async () => result(++count === 1 ? "" : "ERC1967Proxy")) as typeof fetch;
  const labels = new AddressLabels("test-key", request, async () => {}, "");
  await labels.warm([one, two]);
  assert.deepEqual(labels.decorate([one, two]).map(x => x.label), [null, null]);
});

it("does not block rendering while a label request is pending, including after an empty warmup", async () => {
  let resolve!: (response: Response) => void;
  const pending = new Promise<Response>(done => { resolve = done; });
  const labels = new AddressLabels("test-key", (async () => pending) as typeof fetch, async () => {}, "");
  void labels.warm([]);
  const warmup = labels.warm([one, one]);
  assert.equal(labels.loading([one]), true); assert.equal(labels.decorate([one])[0]?.label, null);
  resolve(result("Router")); await warmup;
  assert.equal(labels.loading([one]), false); assert.equal(labels.decorate([one])[0]?.label, "Contract: Router");
});

it("does not expose provider failures or require a key for registry labels", async () => {
  const unavailable = (async () => { throw new Error("secret-bearing-url?apikey=private"); }) as typeof fetch;
  const labels = new AddressLabels("test-key", unavailable, async () => {}, "");
  await labels.warm([one]);
  assert.equal(labels.decorate([one])[0]?.label, null);
  assert.doesNotMatch(JSON.stringify(labels.decorate([one])), /private|secret/);
  const disabled = new AddressLabels("", unavailable, undefined, "");
  await disabled.warm([registry, one]);
  assert.equal(disabled.loading([one]), false); assert.equal(disabled.decorate([registry])[0]?.label, registry.label);
});

it("uses Arkham entity and address identities before contract names without replacing registry labels", async () => {
  let calls = 0;
  const labels = new AddressLabels("etherscan", (async (input, init) => {
    calls++;
    assert.match(String(input), /api\.arkm\.com/);
    assert.equal(new Headers(init?.headers).get("API-Key"), "arkham-test");
    return Response.json({ address: one.address, chain: "ethereum", arkhamEntity: { name: "Example" }, arkhamLabel: { name: "Router" } });
  }) as typeof fetch, async () => {}, "arkham-test");
  await labels.warm([registry, one, one]);
  assert.equal(calls, 1);
  assert.equal(labels.decorate([one])[0]?.label, "Example: Router");
  assert.equal(labels.decorate([one])[0]?.labelSource, "Arkham");
  assert.equal(labels.decorate([registry])[0]?.label, registry.label);
});

it("falls back for unknown Arkham addresses and pauses authorization/rate-limit failures", async () => {
  let arkhamCalls = 0;
  const labels = new AddressLabels("etherscan", (async input => {
    if (String(input).includes("arkm.com")) { arkhamCalls++; return new Response("limited", { status: 429, headers: { "Retry-After": "600" } }); }
    return result("Router");
  }) as typeof fetch, async () => {}, "arkham-test");
  await labels.warm([one, two]);
  assert.equal(arkhamCalls, 1);
  assert.deepEqual(labels.decorate([one, two]).map(row => row.labelSource), ["Etherscan verified contract name", "Etherscan verified contract name"]);
  const unknown = new AddressLabels("", (async () => Response.json({ address: one.address, chain: "ethereum" })) as typeof fetch, async () => {}, "arkham-test");
  await unknown.warm([one]);
  assert.equal(unknown.decorate([one])[0]?.label, null);
});

it("reuses persisted labels and negative results after restart without new API calls", async () => {
  const values = new Map<string, { address: string; value: CachedLabel }>();
  const store: AddressLabelStore = {
    async loadAddressLabels() { return [...values.values()]; },
    async saveAddressLabel(_provider, address, value) { values.set(address, { address, value }); },
  };
  let calls = 0;
  const request = (async input => {
    calls++; const address = String(input).split("/").at(-1)!.split("?")[0];
    return Response.json({ address, chain: "ethereum", ...(address === one.address.toLowerCase() ? { arkhamEntity: { name: "Example" } } : {}) });
  }) as typeof fetch;
  await new AddressLabels("", request, async () => {}, "key", store).warm([one, two]);
  const restarted = new AddressLabels("", request, async () => {}, "key", store);
  await restarted.warm([one, two]);
  assert.equal(calls, 2);
  assert.equal(restarted.decorate([one])[0]?.label, "Example");
  assert.equal(restarted.decorate([two])[0]?.label, null);
});

it("rejects an identity returned for a different address and never exposes credentials", async () => {
  const labels = new AddressLabels("", (async () => Response.json({ address: two.address, chain: "ethereum", arkhamEntity: { name: "Wrong" } })) as typeof fetch, async () => {}, "secret");
  await labels.warm([one]);
  assert.equal(labels.decorate([one])[0]?.label, null);
  assert.doesNotMatch(JSON.stringify(labels.decorate([one])), /secret|Wrong/);
});

it("retains a saved Arkham identity if an expired label refresh fails", async () => {
  const store: AddressLabelStore = {
    async loadAddressLabels() { return [{ address: one.address, value: { label: "Saved identity", source: "Arkham", expiresAt: Date.now() - 1 } }]; },
    async saveAddressLabel() {},
  };
  const labels = new AddressLabels("etherscan", (async input => String(input).includes("arkm.com")
    ? new Response("unavailable", { status: 503 }) : result("Router")) as typeof fetch, async () => {}, "arkham-test", store);
  await labels.warm([one]);
  assert.equal(labels.decorate([one])[0]?.label, "Saved identity");
  assert.equal(labels.decorate([one])[0]?.labelSource, "Arkham");
});

const databaseUrl = process.env.WITHDRAWAL_TEST_DATABASE_URL;
it("persists identity labels, sources and negative results with provider isolation", { skip: !databaseUrl }, async () => {
  const schema = `label_test_${randomBytes(6).toString("hex")}`;
  const admin = new Pool({ connectionString: databaseUrl! });
  const url = new URL(databaseUrl!); url.searchParams.set("options", `-c search_path=${schema}`);
  let store: SnapshotStore | undefined;
  try {
    await admin.query(`CREATE SCHEMA ${schema}`);
    store = new SnapshotStore(url.toString());
    const expiry = Date.now() + 60_000;
    await store.saveAddressLabel("arkham-v1", one.address, { label: "Example", source: "Arkham", expiresAt: expiry });
    await store.saveAddressLabel("arkham-v1", two.address, { label: null, source: null, expiresAt: expiry });
    await store.saveAddressLabel("arkham-v1", one.address, { label: "Old", source: "Arkham", expiresAt: expiry - 1000 });
    await store.saveAddressLabel("arkham-v1", registry.address, { label: "Expired identity", source: "Arkham", expiresAt: Date.now() - 1000 });
    await store.saveAddressLabel("arkham-v1", "0x0000000000000000000000000000000000000000", { label: null, source: null, expiresAt: Date.now() - 1000 });
    await store.close(); store = new SnapshotStore(url.toString());
    const rows = await store.loadAddressLabels("arkham-v1");
    assert.equal(rows.length, 3, "expired positive labels remain available for failure fallback; expired negative entries do not");
    assert.equal(rows.find(row => row.address === one.address.toLowerCase())?.value.label, "Example");
    assert.equal(rows.find(row => row.address === one.address.toLowerCase())?.value.source, "Arkham");
    assert.equal(rows.find(row => row.address === two.address.toLowerCase())?.value.label, null);
    assert.deepEqual(await store.loadAddressLabels("etherscan-v1"), []);
  } finally {
    await store?.close(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end();
  }
});
