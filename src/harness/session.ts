import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";

import type { ModelSpec } from "./models.ts";
import { modelCatalog } from "./models.ts";

const harnessRoot = fileURLToPath(new URL("../..", import.meta.url));
const agentDir = path.join(harnessRoot, ".pi-clean");
const profilerPath = path.join(harnessRoot, "extensions", "profiler.ts");
const cursorExtensionPath = path.join(harnessRoot, "node_modules", "pi-cursor-sdk", "dist", "index.js");

const readOnlyTools = ["read", "grep", "find", "ls"];
const editTools = ["read", "edit", "write", "grep", "find", "ls"];

export function assertWriteAllowed(role: "read" | "edit", cwd: string, targetPath: string): string {
  if (role !== "edit") throw new Error("読み取り役割ではファイル変更は禁止されています");
  if (path.isAbsolute(targetPath)) throw new Error("絶対パスへの書き込みは禁止されています");
  const root = path.resolve(cwd);
  const target = path.resolve(root, targetPath);
  const relative = path.relative(root, target);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error("作業ツリー外への書き込みは禁止されています");
  }
  // Resolve existing path components to prevent writes through symlinks.
  let existing = target;
  while (true) {
    try {
      const real = fsSync.realpathSync(existing);
      const realRelative = path.relative(fsSync.realpathSync(root), real);
      if (realRelative === ".." || realRelative.startsWith(`..${path.sep}`) || path.isAbsolute(realRelative)) {
        throw new Error("作業ツリー外への書き込みは禁止されています");
      }
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = path.dirname(existing);
      if (parent === existing) break;
      existing = parent;
    }
  }
  return target;
}

export function toolsFor(role: "read" | "edit"): string[] {
  return role === "edit" ? editTools : readOnlyTools;
}

export type OfflineFixture = { calls: Array<{ stage: string; text: string; writes?: Array<{ path: string; content: string }> }> ; index: number };

export async function runRole(options: {
  role: "smart" | "cheap";
  fixture?: OfflineFixture;
  stage?: string;
  model: ModelSpec;
  cwd: string;
  prompt: string;
  tools: string[];
}): Promise<string> {
  if (options.fixture) {
    const call = options.fixture.calls[options.fixture.index++];
    if (!call || call.stage !== options.stage) throw new Error(`固定応答の呼び出し段階が一致しません: ${options.stage}`);
    if (call.writes) {
      if (options.stage !== "implement") throw new Error("実装以外の段階では writes を指定できません");
      for (const { path: relative, content } of call.writes) {
        const target = assertWriteAllowed("edit", options.cwd, relative);
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.writeFile(target, content, "utf8");
      }
    }
    return call.text;
  }
  const spec = options.model;
  const modelRuntime = await ModelRuntime.create({
    authPath: path.join(agentDir, "auth.json"),
    modelsStorePath: path.join(agentDir, "models-store.json"),
    refreshOnCreate: false,
  });
  const priorCursorApiKey = process.env.CURSOR_API_KEY;
  // pi-cursor-sdk's initial model discovery reads the default stored credential,
  // independently of ModelRuntime's authPath. Bridge the harness credential
  // through the SDK's supported environment key while loading extensions.
  if (!process.env.CURSOR_API_KEY) {
    try {
      const auth = JSON.parse(await fs.readFile(path.join(agentDir, "auth.json"), "utf8")) as Record<string, any>;
      if (auth.cursor?.type === "api_key" && typeof auth.cursor.key === "string") {
        process.env.CURSOR_API_KEY = auth.cursor.key;
      }
    } catch { /* no saved cursor credential */ }
  }
  const resourceLoader = new DefaultResourceLoader({
    cwd: options.cwd,
    agentDir,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    additionalExtensionPaths: [profilerPath, cursorExtensionPath],
    systemPrompt:
      "あなたはハーネスから呼ばれた作業者です。渡された作業だけを行い、スキルの探索や関係ないツール追加はしないでください。",
    settingsManager: SettingsManager.inMemory(),
  });
  try {
    await resourceLoader.reload();
  } finally {
    if (priorCursorApiKey === undefined) delete process.env.CURSOR_API_KEY; else process.env.CURSOR_API_KEY = priorCursorApiKey;
  }

  const { session, extensionsResult } = await createAgentSession({
    cwd: options.cwd,
    agentDir,
    thinkingLevel: (spec.effort ?? "medium") as any,
    modelRuntime,
    resourceLoader,
    tools: options.tools,
    sessionManager: SessionManager.inMemory(options.cwd),
    settingsManager: SettingsManager.inMemory(),
  });

  const profilerLoaded = extensionsResult.extensions.some((extension) =>
    extension.path.includes("profiler.ts"),
  );
  if (!profilerLoaded) {
    const errors = extensionsResult.errors.map((error) => error.error).join("\n");
    session.dispose();
    throw new Error(`profiler が読み込まれていません\n${errors}`);
  }

  try {
    // Binding extensions dispatches session_start. Do not prompt until the
    // profiler's synchronous session_start handler has created its log.
    const observabilityDir = path.join(options.cwd, ".pi-observability");
    const before = new Set(await fs.readdir(observabilityDir).catch(() => [] as string[]));
    await session.bindExtensions({});
    // Extensions register providers during binding; resolve only after that
    // registration queue has been applied to the runtime.
    const model = modelRuntime.getModel(spec.provider, spec.id);
    if (!model) {
      throw new Error(`モデルが見つかりません: ${options.model} (${spec.provider}/${spec.id})`);
    }
    await session.setModel(model);
    const entries = await fs.readdir(observabilityDir).catch(() => [] as string[]);
    const logCreated = entries.some((entry) => entry.endsWith(".jsonl") && !before.has(entry));
    if (!logCreated) {
      throw new Error("profiler のログファイルを作成できませんでした");
    }

    await session.prompt(options.prompt);
    const text = session.getLastAssistantText();
    if (!text) {
      throw new Error("モデルがテキストを返しませんでした");
    }
    return text;
  } finally {
    session.dispose();
  }
}
