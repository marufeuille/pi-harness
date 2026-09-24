import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import profiler from "./profiler.ts";

test("SDK-shaped tool events record sizes and duplicate counts by input", async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "profiler-test-"));
  const handlers = new Map<string, (event: any, ctx?: any) => Promise<void>>();
  const pi = { on: (name: string, handler: (event: any, ctx?: any) => Promise<void>) => handlers.set(name, handler) } as any;

  try {
    profiler(pi);
    await handlers.get("session_start")!({}, { cwd });

    const call = handlers.get("tool_call")!;
    const result = handlers.get("tool_result")!;
    const events = [
      { id: "1", input: { query: "alpha" } },
      { id: "2", input: { query: "beta" } },
      { id: "3", input: { query: "alpha" } },
    ];
    for (const event of events) {
      await call({ toolCallId: event.id, toolName: "search", input: event.input });
      await result({ toolCallId: event.id, content: [{ type: "text", text: "found" }], isError: false });
    }

    const log = fs.readdirSync(path.join(cwd, ".pi-observability"))[0];
    const records = fs.readFileSync(path.join(cwd, ".pi-observability", log), "utf8")
      .trim().split("\n").map((line) => JSON.parse(line));
    const tools = records.filter((record) => record.type === "tool");
    assert.equal(tools.length, 3);
    assert.ok(tools.every((record) => record.inputChars > 0 && record.outputChars > 0));
    assert.notEqual(tools[0].inputHash, tools[1].inputHash);
    assert.equal(tools[0].inputHash, tools[2].inputHash);
    assert.deepEqual(tools.map((record) => record.duplicateInputCount), [1, 1, 2]);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});
