import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";

import type { ModelAlias } from "./models.ts";
import { modelCatalog } from "./models.ts";

const harnessRoot = fileURLToPath(new URL("../..", import.meta.url));
const agentDir = path.join(harnessRoot, ".pi-clean");
const profilerPath = path.join(harnessRoot, "extensions", "profiler.ts");

const readOnlyTools = ["read", "grep", "find", "ls"];
const editTools = ["read", "bash", "edit", "write", "grep", "find", "ls"];

export function toolsFor(role: "read" | "edit"): string[] {
  return role === "edit" ? editTools : readOnlyTools;
}

export type OfflineFixture = { calls: Array<{ stage: string; text: string; writes?: Array<{ path: string; content: string }> }> ; index: number };

export async function runRole(options: {
  role: "smart" | "cheap";
  fixture?: OfflineFixture;
  stage?: string;
  model: ModelAlias;
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
        if (path.isAbsolute(relative)) throw new Error("絶対パスへの書き込みは禁止されています");
        const target = path.resolve(options.cwd, relative);
        const rel = path.relative(options.cwd, target);
        if (rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) throw new Error("作業ツリー外への書き込みは禁止されています");
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.writeFile(target, content, "utf8");
      }
    }
    return call.text;
  }
  const spec = modelCatalog[options.model];
  const modelRuntime = await ModelRuntime.create({
    authPath: path.join(agentDir, "auth.json"),
    modelsStorePath: path.join(agentDir, "models-store.json"),
    refreshOnCreate: false,
  });
  const model = modelRuntime.getModel(spec.provider, spec.id);
  if (!model) {
    throw new Error(`モデルが見つかりません: ${options.model} (${spec.provider}/${spec.id})`);
  }

  const resourceLoader = new DefaultResourceLoader({
    cwd: options.cwd,
    agentDir,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    additionalExtensionPaths: [profilerPath],
    systemPrompt:
      "あなたはハーネスから呼ばれた作業者です。渡された作業だけを行い、スキルの探索や関係ないツール追加はしないでください。",
    settingsManager: SettingsManager.inMemory(),
  });
  await resourceLoader.reload();

  const { session, extensionsResult } = await createAgentSession({
    cwd: options.cwd,
    agentDir,
    model,
    thinkingLevel: spec.thinking,
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
