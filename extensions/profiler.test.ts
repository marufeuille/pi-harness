import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import profiler from "./profiler.ts";

test("agent_end records full last assistant text, not trailing tool result", async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "profiler-test-"));
  const handlers = new Map<string, (event: any, ctx?: any) => Promise<void>>();
  const pi = { on: (name: string, handler: (event: any, ctx?: any) => Promise<void>) => handlers.set(name, handler) } as any;

  try {
    profiler(pi);
    await handlers.get("session_start")!({}, { cwd });
    const assistantText = JSON.stringify({ assumptions: ["x".repeat(700)] });
    await handlers.get("agent_end")!({ messages: [
      { role: "assistant", content: assistantText },
      { role: "toolResult", content: "tool output" },
    ] });
    const log = fs.readdirSync(path.join(cwd, ".pi-observability"))[0];
    const records = fs.readFileSync(path.join(cwd, ".pi-observability", log), "utf8")
      .trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(records.find((record) => record.type === "agent_end").assistantText, assistantText);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("masks credentials from profiler target, error output, and assistant text", async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "profiler-test-"));
  const handlers = new Map<string, (event: any, ctx?: any) => Promise<void>>();
  const pi = { on: (name: string, handler: (event: any, ctx?: any) => Promise<void>) => handlers.set(name, handler) } as any;
  const secret = "example-sensitive-aws-secret";
  try {
    profiler(pi);
    await handlers.get("session_start")!({}, { cwd });
    await handlers.get("tool_call")!({ toolCallId: "1", toolName: "bash", input: { command: `AWS_SECRET_ACCESS_KEY=${secret} aws sts get-caller-identity` } });
    await handlers.get("tool_result")!({ toolCallId: "1", content: [{ type: "text", text: `failed ${secret}` }], isError: true });
    await handlers.get("agent_end")!({ messages: [{ role: "assistant", content: secret }] });
    const log = fs.readdirSync(path.join(cwd, ".pi-observability"))[0];
    const text = fs.readFileSync(path.join(cwd, ".pi-observability", log), "utf8");
    assert.ok(!text.includes(secret));
  } finally { fs.rmSync(cwd, { recursive: true, force: true }); }
});

test("actual Pi tool call/result events log completed operations for both roles, without credentials", async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "profiler-test-"));
  const handlers = new Map<string, (event: any, ctx?: any) => Promise<void>>();
  const pi = { on: (name: string, handler: (event: any, ctx?: any) => Promise<void>) => handlers.set(name, handler) } as any;
  const secret = "cursor-sensitive-key-value";
  try {
    profiler(pi);
    await handlers.get("session_start")!({}, { cwd });
    const call = handlers.get("tool_call")!;
    const result = handlers.get("tool_result")!;
    for (const [id, toolName, input] of [
      ["r", "read", { path: "src/a.ts" }],
      ["w", "write", { path: "src/a.ts", content: `CURSOR_API_KEY=${secret}` }],
      ["c", "bash", { command: "npm test" }],
      ["s", "grep", { pattern: "needle" }],
    ] as const) {
      await call({ toolCallId: id, toolName, input });
      await result({ toolCallId: id, content: [{ type: "text", text: "done" }], isError: false });
    }
    await call({ toolCallId: "failed", toolName: "write", input: { path: "nope" } });
    await result({ toolCallId: "failed", content: [], isError: true });
    const log = fs.readdirSync(path.join(cwd, ".pi-observability"))[0];
    const records = fs.readFileSync(path.join(cwd, ".pi-observability", log), "utf8");
    assert.ok(records.includes('"target":"src/a.ts"'));
    assert.ok(records.includes('"target":"npm test"'));
    assert.ok(records.includes('"target":"needle"'));
    assert.ok(records.includes('"operation":"read"'));
    assert.ok(records.includes('"operation":"write"'));
    assert.ok(!records.includes(secret));
    assert.equal((records.match(/"type":"tool"/g) ?? []).length, 5);
  } finally { fs.rmSync(cwd, { recursive: true, force: true }); }
});

test("Cursor native operation lifecycle records completed actions, not starts", async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "profiler-test-"));
  const handlers = new Map<string, (event: any, ctx?: any) => Promise<void>>();
  const pi = { on: (name: string, handler: (event: any, ctx?: any) => Promise<void>) => handlers.set(name, handler) } as any;
  const secret = "cursor-native-secret-value";
  try {
    profiler(pi);
    await handlers.get("session_start")!({}, { cwd });
    for (const [id, operation, input] of [
      ["read", "read_file", { path: "src/a.ts" }],
      ["write", "write_file", { path: "src/b.ts" }],
      ["cmd", "run_command", { command: `CURSOR_API_KEY=${secret} npm test` }],
      ["search", "search", { pattern: "needle" }],
    ] as const) {
      await handlers.get("cursor_operation_start")!({ id, operation, input });
    }
    const logfile = path.join(cwd, ".pi-observability", fs.readdirSync(path.join(cwd, ".pi-observability"))[0]);
    assert.equal(fs.readFileSync(logfile, "utf8").split("\n").length, 2);
    for (const [id, result] of [["read", "contents"], ["write", "written"], ["cmd", "passed"], ["search", "matches"]]) {
      await handlers.get("cursor_operation_end")!({ id, result, isError: false });
    }
    const text = fs.readFileSync(logfile, "utf8");
    const records = text.trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(records.filter((record) => record.type === "tool").length, 4);
    assert.ok(text.includes("src/a.ts") && text.includes("src/b.ts") && text.includes("needle") && text.includes("npm test"));
    assert.ok(!text.includes(secret));
  } finally { fs.rmSync(cwd, { recursive: true, force: true }); }
});

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
