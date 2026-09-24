import test from "node:test";
import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { applyStreamOptions, assertWriteAllowed, createHarnessSession, cursorPublishesFast, modelForFastParameter, requireLoadedExtension, toolsFor } from "./session.ts";

const harnessRoot = fileURLToPath(new URL("../..", import.meta.url));
const uniquenessContract = path.join(harnessRoot, "extensions", "edit-uniqueness.ts");

async function withUniquenessContract<T>(run: () => Promise<T>): Promise<T> {
  const existed = existsSync(uniquenessContract);
  if (!existed) {
    const sibling = path.join(harnessRoot, "..", "edit-guard", "extensions", "edit-uniqueness.ts");
    assert.equal(existsSync(sibling), true, "shared contract extensions/edit-uniqueness.ts is missing");
    await copyFile(sibling, uniquenessContract);
  }
  try {
    return await run();
  } finally {
    if (!existed && existsSync(uniquenessContract)) await rm(uniquenessContract, { force: true });
  }
}
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

test("cursor fast false selects the slow model id", () => {
  const models = new Map([
    ["cursor/grok-4.6", { provider: "cursor", id: "grok-4.6" }],
    ["cursor/grok-4.6:fast", { provider: "cursor", id: "grok-4.6:fast" }],
    ["cursor/grok-4.6:slow", { provider: "cursor", id: "grok-4.6:slow" }],
  ]);
  const lookup = (provider: string, id: string) => models.get(`${provider}/${id}`);
  const base = models.get("cursor/grok-4.6")!;
  assert.equal(cursorPublishesFast(base.id, base.provider, lookup), true);
  assert.equal(modelForFastParameter(base, false, lookup).id, "grok-4.6:slow");
  assert.equal(modelForFastParameter(base, true, lookup).id, "grok-4.6:fast");
  assert.equal(modelForFastParameter({ provider: "xai", id: "grok-4.7" }, false, lookup).id, "grok-4.7");
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

test("unloaded uniqueness protection refuses to continue", () => {
  assert.throws(
    () => requireLoadedExtension({ extensions: [{ path: "/tmp/extensions/profiler.ts" }], errors: [] }, "edit-uniqueness.ts"),
    /edit-uniqueness が読み込まれていません/,
  );
  assert.doesNotThrow(() =>
    requireLoadedExtension({ extensions: [{ path: "/tmp/extensions/edit-uniqueness.ts" }], errors: [] }, "edit-uniqueness.ts"),
  );
});

const uniquenessError = /Found \d+ occurrences of .+ must be unique/;

async function profilerRecords(cwd: string): Promise<any[]> {
  const dir = path.join(cwd, ".pi-observability");
  const names = (await readdir(dir)).filter((name) => name.endsWith(".jsonl"));
  assert.equal(names.length, 1);
  const text = await readFile(path.join(dir, names[0]), "utf8");
  return text.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

function uniquenessErrors(records: any[]): any[] {
  return records.filter((record) =>
    record.type === "tool" &&
    record.toolName === "edit" &&
    record.isError === true &&
    uniquenessError.test(String(record.errorOutput ?? "")),
  );
}

async function callSessionTool(session: any, name: string, input: Record<string, unknown>, id: string) {
  const tool = session.agent.state.tools.find((candidate: { name: string }) => candidate.name === name);
  assert.ok(tool, `missing tool ${name}`);
  const args = tool.prepareArguments ? tool.prepareArguments(structuredClone(input)) : input;
  const toolCall = { type: "toolCall", id, name, arguments: args };
  const assistantMessage = {
    role: "assistant",
    content: [toolCall],
    api: "openai-completions",
    provider: "offline",
    model: "offline",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "toolUse",
    timestamp: Date.now(),
  };
  const before = await session.agent.beforeToolCall?.({
    assistantMessage,
    toolCall,
    args,
    context: session.agent.state,
  });
  if (before?.block) {
    return { blocked: true as const, reason: String(before.reason ?? ""), isError: true };
  }
  try {
    const result = await tool.execute(id, args, undefined, undefined);
    await session.agent.afterToolCall?.({
      assistantMessage,
      toolCall,
      args,
      result,
      isError: false,
      context: session.agent.state,
    });
    return { blocked: false as const, isError: false, result };
  } catch (error) {
    const result = {
      content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
      details: {},
    };
    await session.agent.afterToolCall?.({
      assistantMessage,
      toolCall,
      args,
      result,
      isError: true,
      context: session.agent.state,
    });
    return { blocked: false as const, isError: true, result };
  }
}

test("uniqueness retry never reaches edit and session logs keep one error plus the later success", async () => {
  await withUniquenessContract(async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "wire-guard-session-"));
  const relative = "src/harness/steps.ts";
  const oldText = "return toolsFor(role);";
  const original = [
    "function alpha() {",
    `  ${oldText}`,
    "}",
    "function beta() {",
    `  ${oldText}`,
    "}",
    "function gamma() {",
    `  ${oldText}`,
    "}",
    "",
  ].join("\n");
  const expandedOld = ["function gamma() {", `  ${oldText}`, "}"].join("\n");
  const expandedNew = ["function gamma() {", '  return toolsFor("edit");', "}"].join("\n");
  await mkdir(path.join(cwd, "src/harness"), { recursive: true });
  await writeFile(path.join(cwd, relative), original, "utf8");
  let session: Awaited<ReturnType<typeof createHarnessSession>>["session"] | undefined;
  try {
    ({ session } = await createHarnessSession({ cwd, tools: toolsFor("edit") }));
    assert.deepEqual(session.getActiveToolNames().sort(), [...toolsFor("edit")].sort());
    assert.equal(session.getActiveToolNames().includes("bash"), false);

    const definition = session.getToolDefinition("edit");
    assert.ok(definition);
    let editBodyCalls = 0;
    const originalExecute = definition.execute.bind(definition);
    definition.execute = (async (...args: Parameters<typeof originalExecute>) => {
      editBodyCalls += 1;
      return originalExecute(...args);
    }) as typeof definition.execute;

    const first = await callSessionTool(session, "edit", {
      path: relative,
      edits: [{ oldText, newText: "return toolsFor(\"edit\");" }],
    }, "uniq-1");
    assert.equal(first.blocked, false);
    assert.equal(first.isError, true);
    assert.match(String(first.result?.content?.[0]?.text ?? ""), uniquenessError);
    assert.equal(editBodyCalls, 1);
    assert.equal(await readFile(path.join(cwd, relative), "utf8"), original);

    const retry = await callSessionTool(session, "edit", {
      path: relative,
      edits: [{ oldText, newText: "return toolsFor(\"retry\");" }],
    }, "uniq-2");
    assert.equal(retry.blocked, true);
    assert.match(retry.reason, /一致範囲を広げる/);
    assert.equal(editBodyCalls, 1);
    assert.equal(await readFile(path.join(cwd, relative), "utf8"), original);

    const afterRetry = uniquenessErrors(await profilerRecords(cwd));
    assert.equal(afterRetry.length, 1);
    assert.match(String(afterRetry[0].errorOutput), uniquenessError);

    const expanded = await callSessionTool(session, "edit", {
      path: relative,
      edits: [{ oldText: expandedOld, newText: expandedNew }],
    }, "uniq-3");
    assert.equal(expanded.blocked, false);
    assert.equal(expanded.isError, false);
    assert.equal(editBodyCalls, 2);
    assert.match(String(expanded.result?.content?.[0]?.text ?? ""), /Successfully replaced/);
    assert.equal(await readFile(path.join(cwd, relative), "utf8"), original.replace(expandedOld, expandedNew));

    const records = await profilerRecords(cwd);
    const errors = uniquenessErrors(records);
    assert.equal(errors.length, 1, JSON.stringify(records, null, 2));
    assert.equal(errors[0].target, relative);
    const successes = records.filter((record) =>
      record.type === "tool" && record.toolName === "edit" && record.isError === false && record.target === relative,
    );
    assert.equal(successes.length, 1);
    assert.equal(successes[0].errorOutput, undefined);
  } finally {
    session?.dispose();
    await rm(cwd, { recursive: true, force: true });
  }
  });
});
