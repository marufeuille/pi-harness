import assert from "node:assert/strict";
import test from "node:test";
import { maskSecrets } from "./mask.ts";

test("masks common credentials", () => {
  const masked = maskSecrets("api_key=abc123 Bearer eyJhbGciOiJ SECRET_KEY: xyz password=hunter2 sk-abcdefghijklmnop");
  for (const secret of ["abc123", "eyJhbGciOiJ", "xyz", "hunter2", "sk-abcdefghijklmnop"]) assert.ok(!masked.includes(secret));
});
