import test from "node:test";
import assert from "node:assert/strict";
import { applyStreamOptions, assertWriteAllowed, toolsFor } from "./session.ts";

test("fast options reach the SDK runtime streamSimple boundary, including false", () => {
  for (const fast of [true, false]) {
    let received: Record<string, unknown> | undefined;
    const model = { provider: "xai", id: "grok-4.7" };
    const runtime = {
      streamSimple(_model: unknown, _context: unknown, options: Record<string, unknown> = {}) {
        received = options;
      },
    };
    assert.equal("stream" in model, false);
    applyStreamOptions(runtime, { fast });
    runtime.streamSimple(model, { messages: [] }, { temperature: 0.2 });
    assert.deepEqual(received, { temperature: 0.2, fast });
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
