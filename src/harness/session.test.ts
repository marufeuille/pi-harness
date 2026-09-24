import test from "node:test";
import assert from "node:assert/strict";
import { applyStreamOptions, assertWriteAllowed, toolsFor } from "./session.ts";

test("fast invocation setting reaches the model stream boundary, including false and default true", () => {
  for (const fast of [true, false, undefined]) {
    let received: Record<string, unknown> | undefined;
    const model = { stream(_request: unknown, options: Record<string, unknown> = {}) { received = options; } };
    applyStreamOptions(model, { fast: fast ?? true });
    model.stream({});
    assert.equal(received?.fast, fast ?? true);
  }
});

test("roles never expose unrestricted shell commands", () => {
  assert.equal(toolsFor("read").includes("bash"), false);
  assert.equal(toolsFor("edit").includes("bash"), false);
});

test("write boundary rejects read-role and out-of-tree writes while allowing in-tree writes", () => {
  assert.throws(() => assertWriteAllowed("read", "/tmp/work", "file.txt"));
  assert.throws(() => assertWriteAllowed("edit", "/tmp/work", "../outside.txt"));
  assert.equal(assertWriteAllowed("edit", "/tmp/work", "src/file.txt"), "/tmp/work/src/file.txt");
});

test("read role cannot access mutation tools", () => {
  const tools = toolsFor("read");
  assert.equal(tools.includes("write"), false);
  assert.equal(tools.includes("edit"), false);
});
