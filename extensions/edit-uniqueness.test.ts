import assert from "node:assert/strict";
import test from "node:test";

import editUniqueness from "./edit-uniqueness.ts";

type Handler = (event: any, ctx?: any) => Promise<any>;

function install() {
  const handlers = new Map<string, Handler>();
  const pi = {
    on: (name: string, handler: Handler) => {
      handlers.set(name, handler);
    },
  };
  editUniqueness(pi);
  return handlers;
}

const cwd = "/tmp/edit-guard-work";
const ctx = { cwd };
const file = "src/harness/steps.ts";
const oldText = "return toolsFor(role);";
const newText = "return [...toolsFor(role), \"edit\"];";
const uniquenessError =
  "Found 3 occurrences of edits[2] in src/harness/steps.ts. Each oldText must be unique. Please provide more context to make it unique.";
const singleUniquenessError =
  "Found 3 occurrences of the text in src/harness/steps.ts. The text must be unique. Please provide more context to make it unique.";

function editInput(over: Record<string, unknown> = {}) {
  return {
    path: file,
    edits: [{ oldText, newText }],
    ...over,
  };
}

function errorContent(text: string) {
  return [{ type: "text", text }];
}

async function recordUniqueness(
  handlers: Map<string, Handler>,
  options: {
    id?: string;
    input?: Record<string, unknown>;
    error?: string;
    isError?: boolean;
  } = {},
) {
  const id = options.id ?? "call-1";
  const input = options.input ?? editInput();
  const call = await handlers.get("tool_call")!(
    { toolCallId: id, toolName: "edit", input },
    ctx,
  );
  const event = {
    toolCallId: id,
    toolName: "edit",
    input,
    content: errorContent(options.error ?? singleUniquenessError),
    isError: options.isError ?? true,
  };
  const snapshot = structuredClone(event);
  const result = await handlers.get("tool_result")!(event, ctx);
  return { call, result, event, snapshot };
}

test("一意性エラーの後、同一ファイル・同一 oldText の再実行を拒否する", async () => {
  const handlers = install();
  const first = await recordUniqueness(handlers);
  assert.equal(first.call, undefined);
  assert.equal(first.result, undefined);
  assert.deepEqual(first.event, first.snapshot);

  const blocked = await handlers.get("tool_call")!(
    {
      toolCallId: "call-2",
      toolName: "edit",
      input: editInput({ edits: [{ oldText, newText: "別の置換" }] }),
    },
    ctx,
  );
  assert.equal(blocked?.block, true);
  assert.match(blocked.reason, /一致範囲を広げる/);
  assert.match(blocked.reason, /中止/);
});

test("newText を変えても同一 oldText の禁止は解除しない", async () => {
  const handlers = install();
  await recordUniqueness(handlers);
  const blocked = await handlers.get("tool_call")!(
    {
      toolCallId: "retry",
      toolName: "edit",
      input: { path: file, edits: [{ oldText, newText: "totally different" }] },
    },
    ctx,
  );
  assert.equal(blocked?.block, true);
});

test("oldText を広げた編集・別ファイル・一意性以外のエラーは妨げない", async () => {
  const handlers = install();
  await recordUniqueness(handlers);

  const expanded = await handlers.get("tool_call")!(
    {
      toolCallId: "expanded",
      toolName: "edit",
      input: {
        path: file,
        edits: [{ oldText: `function tools() {\n  ${oldText}\n}`, newText: "ok" }],
      },
    },
    ctx,
  );
  assert.ok(!expanded?.block);

  const otherFile = await handlers.get("tool_call")!(
    {
      toolCallId: "other-file",
      toolName: "edit",
      input: { path: "src/harness/session.ts", edits: [{ oldText, newText }] },
    },
    ctx,
  );
  assert.ok(!otherFile?.block);

  const missHandlers = install();
  await recordUniqueness(missHandlers, {
    error:
      "Could not find edits[0] in src/harness/steps.ts. The oldText must match exactly including all whitespace and newlines.",
  });
  const retryMiss = await missHandlers.get("tool_call")!(
    { toolCallId: "retry-miss", toolName: "edit", input: editInput() },
    ctx,
  );
  assert.ok(!retryMiss?.block);
});

test("複数編集ではエラーが指す edits[2] の oldText だけを記録する", async () => {
  const handlers = install();
  const edits = [
    { oldText: "alpha", newText: "A" },
    { oldText: "beta", newText: "B" },
    { oldText: "gamma", newText: "C" },
  ];
  await recordUniqueness(handlers, {
    input: { path: file, edits },
    error: uniquenessError,
  });

  const gamma = await handlers.get("tool_call")!(
    {
      toolCallId: "gamma",
      toolName: "edit",
      input: { path: file, edits: [{ oldText: "gamma", newText: "C2" }] },
    },
    ctx,
  );
  assert.equal(gamma?.block, true);

  const alpha = await handlers.get("tool_call")!(
    {
      toolCallId: "alpha",
      toolName: "edit",
      input: { path: file, edits: [{ oldText: "alpha", newText: "A2" }] },
    },
    ctx,
  );
  assert.ok(!alpha?.block);

  const mixed = await handlers.get("tool_call")!(
    {
      toolCallId: "mixed",
      toolName: "edit",
      input: {
        path: file,
        edits: [
          { oldText: "alpha", newText: "A3" },
          { oldText: "gamma", newText: "C3" },
        ],
      },
    },
    ctx,
  );
  assert.equal(mixed?.block, true);
});

test("同一ファイルの相対パス表記揺れを正規化する", async () => {
  const handlers = install();
  await recordUniqueness(handlers, { input: { path: "./src/harness/steps.ts", edits: [{ oldText, newText }] } });

  for (const variant of ["src/harness/steps.ts", "src/harness/../harness/steps.ts", `${cwd}/src/harness/steps.ts`]) {
    const blocked = await handlers.get("tool_call")!(
      {
        toolCallId: `path-${variant}`,
        toolName: "edit",
        input: { path: variant, edits: [{ oldText, newText }] },
      },
      ctx,
    );
    assert.equal(blocked?.block, true, variant);
  }
});

test("別セッションの同じ編集は妨げない", async () => {
  const first = install();
  await recordUniqueness(first);
  const second = install();
  const allowed = await second.get("tool_call")!(
    { toolCallId: "other-session", toolName: "edit", input: editInput() },
    ctx,
  );
  assert.ok(!allowed?.block);
});

test("session_start で記憶を捨て、成功や一意性以外では禁止しない", async () => {
  const handlers = install();
  await recordUniqueness(handlers);
  await handlers.get("session_start")!({}, ctx);
  const afterReset = await handlers.get("tool_call")!(
    { toolCallId: "after-reset", toolName: "edit", input: editInput() },
    ctx,
  );
  assert.ok(!afterReset?.block);

  await recordUniqueness(handlers, { id: "ok", isError: false, error: "Successfully replaced 1 block(s) in src/harness/steps.ts." });
  const stillOk = await handlers.get("tool_call")!(
    { toolCallId: "still-ok", toolName: "edit", input: editInput() },
    ctx,
  );
  assert.ok(!stillOk?.block);
});

test("実際の edit 入力形式（legacy / 文字列 edits / 単一オブジェクト）に対応する", async () => {
  const legacy = install();
  await recordUniqueness(legacy, {
    input: { path: file, oldText, newText },
    error: singleUniquenessError,
  });
  const legacyBlocked = await legacy.get("tool_call")!(
    { toolCallId: "legacy-retry", toolName: "edit", input: { path: file, oldText, newText: "x" } },
    ctx,
  );
  assert.equal(legacyBlocked?.block, true);

  const stringed = install();
  await recordUniqueness(stringed, {
    input: { path: file, edits: JSON.stringify([{ oldText, newText }]) },
    error: singleUniquenessError,
  });
  const stringedBlocked = await stringed.get("tool_call")!(
    { toolCallId: "string-retry", toolName: "edit", args: { path: file, edits: { oldText, newText } } },
    ctx,
  );
  assert.equal(stringedBlocked?.block, true);
});

test("tool_result は元の一意性エラーを書き換えない", async () => {
  const handlers = install();
  const recorded = await recordUniqueness(handlers, { error: uniquenessError, input: {
    path: file,
    edits: [
      { oldText: "a", newText: "A" },
      { oldText: "b", newText: "B" },
      { oldText, newText },
    ],
  } });
  assert.equal(recorded.result, undefined);
  assert.equal(recorded.event.isError, true);
  assert.equal(recorded.event.content[0].text, uniquenessError);
  assert.deepEqual(recorded.event, recorded.snapshot);
});
