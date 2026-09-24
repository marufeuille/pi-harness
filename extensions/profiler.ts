import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

import type {
  ExtensionAPI,
} from "@earendil-works/pi-coding-agent";

type ActiveCall = {
  toolName: string;
  startedAt: number;
  inputChars: number;
  inputHash: string;
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
  pi.on("session_start", async (_event, ctx) => {
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
      cwd: ctx.cwd,
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

    active.set(
      event.toolCallId,
      {
        toolName: event.toolName,
        startedAt: performance.now(),
        inputChars,
        inputHash,
      },
    );
  });

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
    };

    write(record);

    active.delete(event.toolCallId);
  });

  /*
   * 1回のagent run終了
   */
  pi.on("agent_end", async () => {
    write({
      timestamp: new Date().toISOString(),
      type: "agent_end",
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
