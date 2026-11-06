import assert from "node:assert/strict";
import { it } from "node:test";
import { AddressLabels } from "../src/address-labels.js";

const one = { address: "0x958A0904940f744f8c6b72c043CeeE3EA34AE888", label: null };
const two = { address: "0xD00e0079B8CAB524F3fa20EA879a7736E512a5Fc", label: null };
const registry = { address: "0x1601843c5E9bC251A3272907010AFa41Fa18347E", label: "Spark ALM Proxy" };
const result = (name: string) => Response.json({ status: "1", result: [{ ContractName: name }] });

it("keeps registry identities and distinguishes verified contract names from owner labels", async () => {
  const urls: URL[] = [];
  const request = (async input => { urls.push(new URL(String(input))); return result("LitePSMAggregator"); }) as typeof fetch;
  const labels = new AddressLabels("test-key", request, async () => {});
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
  const labels = new AddressLabels("test-key", request, async () => {});
  await labels.warm([one, two]);
  assert.deepEqual(labels.decorate([one, two]).map(x => x.label), [null, null]);
});

it("does not block rendering while a label request is pending, including after an empty warmup", async () => {
  let resolve!: (response: Response) => void;
  const pending = new Promise<Response>(done => { resolve = done; });
  const labels = new AddressLabels("test-key", (async () => pending) as typeof fetch, async () => {});
  void labels.warm([]);
  const warmup = labels.warm([one, one]);
  assert.equal(labels.loading([one]), true); assert.equal(labels.decorate([one])[0]?.label, null);
  resolve(result("Router")); await warmup;
  assert.equal(labels.loading([one]), false); assert.equal(labels.decorate([one])[0]?.label, "Contract: Router");
});

it("does not expose provider failures or require a key for registry labels", async () => {
  const unavailable = (async () => { throw new Error("secret-bearing-url?apikey=private"); }) as typeof fetch;
  const labels = new AddressLabels("test-key", unavailable, async () => {});
  await labels.warm([one]);
  assert.equal(labels.decorate([one])[0]?.label, null);
  assert.doesNotMatch(JSON.stringify(labels.decorate([one])), /private|secret/);
  const disabled = new AddressLabels("", unavailable);
  await disabled.warm([registry, one]);
  assert.equal(disabled.loading([one]), false); assert.equal(disabled.decorate([registry])[0]?.label, registry.label);
});
