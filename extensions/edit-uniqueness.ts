import path from "node:path";

type EditReplacement = {
  oldText: string;
  newText: string;
};

type ParsedEdit = {
  path: string;
  edits: EditReplacement[];
};

const BLOCK_REASON =
  "同じファイルの同じ oldText は一意でないため再実行できません。一致範囲を広げるか、この編集を中止してください。";

function toolNameOf(event: any): string {
  return event?.toolName ?? event?.name ?? "";
}

function inputOf(event: any): unknown {
  return event?.input ?? event?.args ?? {};
}

function isSingleEditInput(value: unknown): value is EditReplacement {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const edit = value as Record<string, unknown>;
  return typeof edit.oldText === "string" && typeof edit.newText === "string";
}

/** Match the edit tool's prepareArguments: stringified edits, a single object, or legacy oldText/newText. */
function parseEditInput(input: unknown): ParsedEdit | undefined {
  if (!input || typeof input !== "object") return undefined;
  const args = { ...(input as Record<string, unknown>) };
  const rawPath = args.path ?? args.file_path ?? args.filePath;
  if (typeof rawPath !== "string" || rawPath.length === 0) return undefined;

  if (typeof args.edits === "string") {
    try {
      const parsed = JSON.parse(args.edits);
      if (Array.isArray(parsed)) args.edits = parsed;
      else if (isSingleEditInput(parsed)) args.edits = [parsed];
    } catch {
      /* keep the original string; edits stay unused */
    }
  } else if (isSingleEditInput(args.edits)) {
    args.edits = [args.edits];
  }

  const edits: EditReplacement[] = [];
  if (Array.isArray(args.edits)) {
    for (const item of args.edits) {
      if (!item || typeof item !== "object") continue;
      const edit = item as Record<string, unknown>;
      if (typeof edit.oldText !== "string") continue;
      edits.push({
        oldText: edit.oldText,
        newText: typeof edit.newText === "string" ? edit.newText : "",
      });
    }
  }
  if (typeof args.oldText === "string" && typeof args.newText === "string") {
    edits.push({ oldText: args.oldText, newText: args.newText });
  }
  if (edits.length === 0) return undefined;
  return { path: rawPath, edits };
}

function normalizeEditPath(raw: string, cwd?: string): string {
  const asPosix = raw.replace(/\\/g, "/");
  if (cwd) return path.normalize(path.resolve(cwd, asPosix));
  const normalized = path.posix.normalize(asPosix);
  if (normalized === "." || normalized === "") return normalized;
  return normalized.replace(/^\.\//, "");
}

function resultText(event: any): string {
  const content = event?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((item) => (item && typeof item.text === "string" ? item.text : ""))
      .join("\n");
  }
  return "";
}

/** Return the failing edits[] index for uniqueness errors; ignore not-found / overlap / empty-oldText. */
function uniquenessEditIndex(text: string): number | undefined {
  const multi = text.match(
    /Found \d+ occurrences of edits\[(\d+)\] .*\. Each oldText must be unique/,
  );
  if (multi) return Number(multi[1]);
  if (/Found \d+ occurrences of the text in .+\. The text must be unique/.test(text)) {
    return 0;
  }
  return undefined;
}

function banKey(file: string, oldText: string): string {
  return JSON.stringify([file, oldText]);
}

export default function editUniqueness(pi: any) {
  const banned = new Set<string>();
  const pending = new Map<string, ParsedEdit>();
  let sessionCwd: string | undefined;

  function resolveCwd(ctx?: any): string | undefined {
    return typeof ctx?.cwd === "string" ? ctx.cwd : sessionCwd;
  }

  function keyFor(file: string, oldText: string, cwd?: string): string {
    return banKey(normalizeEditPath(file, cwd), oldText);
  }

  pi.on("session_start", async (_event: any, ctx: any) => {
    banned.clear();
    pending.clear();
    sessionCwd = typeof ctx?.cwd === "string" ? ctx.cwd : undefined;
  });

  pi.on("tool_call", async (event: any, ctx: any) => {
    if (toolNameOf(event) !== "edit") return;
    const parsed = parseEditInput(inputOf(event));
    if (!parsed) return;
    const cwd = resolveCwd(ctx);
    for (const edit of parsed.edits) {
      if (!banned.has(keyFor(parsed.path, edit.oldText, cwd))) continue;
      return { block: true, reason: BLOCK_REASON };
    }
    const id = event.toolCallId;
    if (typeof id === "string") pending.set(id, parsed);
  });

  pi.on("tool_result", async (event: any, ctx: any) => {
    if (toolNameOf(event) !== "edit") return undefined;
    const id = event.toolCallId;
    const parsed =
      (typeof id === "string" ? pending.get(id) : undefined) ?? parseEditInput(inputOf(event));
    if (typeof id === "string") pending.delete(id);
    if (!event.isError || !parsed) return undefined;
    const index = uniquenessEditIndex(resultText(event));
    if (index === undefined) return undefined;
    const oldText = parsed.edits[index]?.oldText;
    if (typeof oldText !== "string") return undefined;
    banned.add(keyFor(parsed.path, oldText, resolveCwd(ctx)));
    return undefined;
  });
}
