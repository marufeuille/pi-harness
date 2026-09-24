import test from "node:test";
import assert from "node:assert/strict";
import { assertWriteAllowed, toolsFor } from "./session.ts";

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
