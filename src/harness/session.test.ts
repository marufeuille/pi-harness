import test from "node:test";
import assert from "node:assert/strict";
import { toolsFor } from "./session.ts";

test("roles never expose unrestricted shell commands", () => {
  assert.equal(toolsFor("read").includes("bash"), false);
  assert.equal(toolsFor("edit").includes("bash"), false);
});

test("read role cannot access mutation tools", () => {
  const tools = toolsFor("read");
  assert.equal(tools.includes("write"), false);
  assert.equal(tools.includes("edit"), false);
});
