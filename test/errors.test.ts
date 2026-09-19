import assert from "node:assert/strict";
import { it } from "node:test";
import { safeErrorMessage } from "../src/errors.js";

it("does not expose RPC URLs from verbose provider errors", () => {
  const error = new Error("RPC Request failed.\n\nURL: https://provider.example/secret-key\nDetails: rate limited");
  assert.equal(safeErrorMessage(error), "RPC Request failed.");
});
