import assert from "node:assert/strict";
import test from "node:test";
import { maskSecrets } from "./mask.ts";

test("masks common credentials", () => {
  const masked = maskSecrets("api_key=abc123 Bearer eyJhbGciOiJ SECRET_KEY: xyz password=hunter2 sk-abcdefghijklmnop");
  for (const secret of ["abc123", "eyJhbGciOiJ", "xyz", "hunter2", "sk-abcdefghijklmnop"]) assert.ok(!masked.includes(secret));
});

test("masks prefixed environment-variable credentials and preserves other text", () => {
  const input = "LINEAR_API_KEY=lin_api_example123 DB_PASSWORD=hunter2 note=keep-this";
  const masked = maskSecrets(input);
  assert.ok(!masked.includes("lin_api_example123"));
  assert.ok(!masked.includes("hunter2"));
  assert.ok(masked.includes("note=keep-this"));
});

test("masks quoted prefixed environment-variable credentials", () => {
  const input = '\"LINEAR_API_KEY\":\"lin_api_example123\", \'DB_PASSWORD\':\'hunter2\'';
  const masked = maskSecrets(input);
  assert.ok(!masked.includes("lin_api_example123"));
  assert.ok(!masked.includes("hunter2"));
});

test("masks generic token assignments and Basic authorization in logged text", () => {
  const sensitive = "example-sensitive-token";
  const basic = "dXNlcjpwYXNz";
  const records = [
    `GH_TOKEN=${sensitive} gh api user`,
    `command failed: Authorization: Basic ${basic}`,
    `The request failed with Authorization: Basic ${basic}`,
  ];
  for (const record of records) {
    const masked = maskSecrets(record);
    assert.ok(!masked.includes(sensitive));
    assert.ok(!masked.includes(basic));
  }
  assert.ok(!maskSecrets('{"GH_TOKEN":"example-sensitive-token"}').includes(sensitive));
});

test("masks quoted credentials in malformed JSON-like text", () => {
  const input = '{"api_key":"abc123", "access_token":"token123", "password":"hunter 2 rocks",';
  const masked = maskSecrets(input);
  for (const secret of ["abc123", "token123", "hunter 2 rocks"]) assert.ok(!masked.includes(secret));
  assert.match(masked, /\[REDACTED\]/g);
});
