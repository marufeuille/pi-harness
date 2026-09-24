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

export async function runRole(options: {
  role: "smart" | "cheap";
  model: ModelAlias;
  cwd: string;
  prompt: string;
  tools: string[];
}): Promise<string> {
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
