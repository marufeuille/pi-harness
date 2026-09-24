import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { maskSecrets } from "../src/harness/mask.ts";

import type {
  ExtensionAPI,
} from "@earendil-works/pi-coding-agent";

type ActiveCall = {
  toolName: string;
  startedAt: number;
  inputChars: number;
  inputHash: string;
  target: string;
};

type ToolLog = {
  timestamp: string;
  type: "tool";
  toolCallId: string;
  toolName: string;

  durationMs: number;

  inputChars: number;
  outputChars: number;

  inputHash: string;
  duplicateInputCount: number;

  isError: boolean;
  errorOutput?: string;
};

function sizeOf(value: unknown): number {
  if (value === undefined || value === null) {
    return 0;
  }

  try {
    return JSON.stringify(value).length;
  } catch {
    return String(value).length;
  }
}

const MAX_CHARS = 500;

function safeText(value: unknown, limit = MAX_CHARS): string {
  let text: string;
  try { text = typeof value === "string" ? value : JSON.stringify(value) ?? String(value); }
  catch { text = String(value); }
  return maskSecrets(text).slice(0, limit);
}

function targetOf(tool: string, input: unknown): string {
  const args = input && typeof input === "object" ? input as Record<string, unknown> : {};
  const keys = /read|write|edit|bash|command|grep|search|find/i.test(tool);
  const preferred = /bash|command/i.test(tool) ? ["command", "cmd"] : /grep|search|find/i.test(tool) ? ["pattern", "query"] : ["path", "file_path", "filePath", "command", "pattern"];
  if (!keys) return "";
  const key = preferred.find((name) => args[name] !== undefined);
  return key ? safeText(args[key]) : "";
}

function hash(value: unknown): string {
  const json = JSON.stringify(value);

  return crypto
    .createHash("sha256")
    .update(json)
    .digest("hex")
    .slice(0, 12);
}

function extractTextSize(content: unknown): number {
  if (!Array.isArray(content)) {
    return 0;
  }

  let size = 0;

  for (const item of content) {
    if (item?.type === "text" && typeof item.text === "string") {
      size += item.text.length;
    } else {
      size += sizeOf(item);
    }
  }

  return size;
}

export default function profiler(pi: ExtensionAPI) {
  const active = new Map<string, ActiveCall>();

  /*
   * 同じtool + 同じargsが何回呼ばれたかを記録
   */
  const seenInputs = new Map<string, number>();

  let logFile: string | undefined;
  const sessionSecrets = new Set<string>();

  function redact(value: unknown, limit = MAX_CHARS): string {
    let raw: string;
    try { raw = typeof value === "string" ? value : JSON.stringify(value) ?? String(value); }
    catch { raw = String(value); }
    for (const match of raw.matchAll(/(?:AWS_SECRET_ACCESS_KEY|[A-Z0-9_]*(?:API_KEY|ACCESS_TOKEN|SECRET_KEY|TOKEN|PASSWORD))\s*[:=]\s*["']?([^\s"',;]+)/gi)) {
      if (match[1] && match[1].length >= 3) sessionSecrets.add(match[1]);
    }
    let text = maskSecrets(raw);
    for (const secret of sessionSecrets) text = text.split(secret).join("[REDACTED]");
    return text.slice(0, limit);
  }

  function write(record: unknown) {
    if (!logFile) {
      return;
    }

    fs.appendFileSync(
      logFile,
      JSON.stringify(record) + "\n",
    );
  }

  /*
   * セッション開始時にログファイルを作る
   */
  pi.on("session_start", async (event, ctx) => {
    const dir = path.join(
      ctx.cwd,
      ".pi-observability",
    );

    fs.mkdirSync(dir, {
      recursive: true,
    });

    const timestamp = new Date()
      .toISOString()
      .replace(/[:.]/g, "-");

    logFile = path.join(
      dir,
      `${timestamp}.jsonl`,
    );

    write({
      timestamp: new Date().toISOString(),
      type: "session_start",
      cwd: safeText(ctx.cwd),
      model: safeText((event as any)?.model ?? (ctx as any)?.model ?? "unknown"),
    });

    console.error(
      `[profiler] logging to ${logFile}`,
    );
  });

  /*
   * Tool実行前
   */
  pi.on("tool_call", async (event) => {
    const inputChars = sizeOf(event.input);
    const inputHash = hash({
      tool: event.toolName,
      input: event.input,
    });

    const duplicateInputCount =
      (seenInputs.get(inputHash) ?? 0) + 1;

    seenInputs.set(
      inputHash,
      duplicateInputCount,
    );

    redact(event.input);

    active.set(
      event.toolCallId,
      {
        toolName: event.toolName,
        startedAt: performance.now(),
        inputChars,
        inputHash,
        target: redact(targetOf(event.toolName, event.input)),
      },
    );
  });

  // Cursor's native operations are outside Pi's tool event stream. Log the
  // actual Pi tool calls and their results; a successful result is the
  // completion signal (never treat a call/start notification as success).
  /*
   * Tool実行後
   */
  pi.on("tool_result", async (event) => {
    const current = active.get(
      event.toolCallId,
    );

    if (!current) {
      return;
    }

    const durationMs =
      performance.now() - current.startedAt;

    const outputChars =
      extractTextSize(event.content);

    const duplicateInputCount =
      seenInputs.get(current.inputHash) ?? 1;

    const record: ToolLog = {
      timestamp: new Date().toISOString(),

      type: "tool",

      toolCallId: event.toolCallId,
      toolName: current.toolName,

      durationMs: Math.round(durationMs),

      inputChars: current.inputChars,
      outputChars,

      inputHash: current.inputHash,
      duplicateInputCount,

      isError: event.isError ?? false,
      operation: current.toolName,
      target: current.target,
      ...(event.isError ? { errorOutput: redact((event as any).content?.map?.((item: any) => item.text ?? "").join("\n") ?? event.content) } : {}),
    };

    write(record);

    active.delete(event.toolCallId);
  });

  /*
   * 1回のagent run終了
   */
  pi.on("agent_end", async (event) => {
    const messages = (event as any)?.messages;
    const last = Array.isArray(messages)
      ? [...messages].reverse().find((message: any) => message?.role === "assistant")
      : undefined;
    const text = typeof last?.content === "string" ? last.content : Array.isArray(last?.content)
      ? last.content.filter((part: any) => part?.type === "text").map((part: any) => part.text).join("\n")
      : "";
    write({
      timestamp: new Date().toISOString(),
      type: "agent_end",
      assistantText: redact(text, Number.POSITIVE_INFINITY),
    });
  });

  /*
   * 完全にsettleした地点
   */
  pi.on("agent_settled", async () => {
    write({
      timestamp: new Date().toISOString(),
      type: "agent_settled",
    });
  });

  pi.on("session_shutdown", async () => {
    write({
      timestamp: new Date().toISOString(),
      type: "session_shutdown",
    });
  });
}
