import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { AgentSession, ModelRuntime } from "@earendil-works/pi-coding-agent";

import type { ModelSpec } from "./models.ts";
import { modelCatalog, registerRuntimeModel, resolveAndValidateModel } from "./models.ts";

const harnessRoot = fileURLToPath(new URL("../..", import.meta.url));
const agentDir = path.join(harnessRoot, ".pi-clean");
const profilerPath = path.join(harnessRoot, "extensions", "profiler.ts");
const editUniquenessPath = path.join(harnessRoot, "extensions", "edit-uniqueness.ts");
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

type StreamRuntime = {
  streamSimple: (model: unknown, context: unknown, options?: Record<string, unknown>) => unknown;
};

/** Intercept the SDK's stream invocation boundary; runtime models themselves do not expose stream(). */
export function applyStreamOptions<T extends StreamRuntime>(runtime: T, options: Record<string, unknown>): T {
  const streamSimple = runtime.streamSimple.bind(runtime);
  runtime.streamSimple = ((model: unknown, context: unknown, streamOptions: Record<string, unknown> = {}) =>
    streamSimple(model, context, { ...streamOptions, ...options })) as T["streamSimple"];
  return runtime;
}

/** Cursor encodes fast on the model id (`id:fast` / `id:slow`). Stream options are ignored. */
export function cursorFastVariantId(modelId: string, fast: boolean): string {
  const baseId = modelId.replace(/:(?:fast|slow)$/, "");
  return `${baseId}:${fast ? "fast" : "slow"}`;
}

export function cursorPublishesFast(modelId: string, provider: string, lookup: (provider: string, id: string) => unknown): boolean {
  if (provider !== "cursor") return false;
  if (modelId.endsWith(":fast") || modelId.endsWith(":slow")) return true;
  const baseId = modelId.replace(/:(?:fast|slow)$/, "");
  return Boolean(lookup(provider, `${baseId}:fast`) || lookup(provider, `${baseId}:slow`));
}

export function modelForFastParameter<T extends { provider: string; id: string }>(
  model: T,
  fast: unknown,
  lookup: (provider: string, id: string) => T | undefined,
): T {
  if (model.provider !== "cursor" || typeof fast !== "boolean") return model;
  const variant = lookup(model.provider, cursorFastVariantId(model.id, fast));
  if (!variant) throw new Error(`モデルが fast ${String(fast)} をサポートしていません`);
  return variant;
}

export type OfflineFixture = { calls: Array<{ stage: string; text: string; writes?: Array<{ path: string; content: string }>; checkout?: string }> ; index: number };

export type HarnessExtensionsResult = {
  extensions: Array<{ path: string }>;
  errors: Array<{ error: unknown }>;
};

export function requireLoadedExtension(extensionsResult: HarnessExtensionsResult, fileName: string): void {
  const loaded = extensionsResult.extensions.some((extension) => extension.path.includes(fileName));
  if (loaded) return;
  const errors = extensionsResult.errors.map((error) => String(error.error)).join("\n");
  throw new Error(`${fileName.replace(/\.ts$/, "")} が読み込まれていません\n${errors}`);
}

export async function createHarnessSession(options: {
  cwd: string;
  tools: string[];
  thinkingLevel?: string;
}): Promise<{ session: AgentSession; modelRuntime: ModelRuntime }> {
  const {
    createAgentSession,
    DefaultResourceLoader,
    ModelRuntime,
    SessionManager,
    SettingsManager,
  } = await import("@earendil-works/pi-coding-agent");
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
    additionalExtensionPaths: [profilerPath, editUniquenessPath, cursorExtensionPath],
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
    thinkingLevel: options.thinkingLevel as any,
    modelRuntime,
    resourceLoader,
    tools: options.tools,
    sessionManager: SessionManager.inMemory(options.cwd),
    settingsManager: SettingsManager.inMemory(),
  });

  try {
    requireLoadedExtension(extensionsResult, "profiler.ts");
    requireLoadedExtension(extensionsResult, "edit-uniqueness.ts");
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
  } catch (error) {
    session.dispose();
    throw error;
  }
  return { session, modelRuntime };
}

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
    if (call.checkout) {
      if (options.stage !== "implement") throw new Error("実装以外の段階では checkout を指定できません");
      const { execFile } = await import("node:child_process");
      const { promisify } = await import("node:util");
      await promisify(execFile)("git", ["checkout", "-b", call.checkout], { cwd: options.cwd });
    }
    return call.text;
  }
  const spec = options.model;
  const parameters = spec.parameters ?? {};
  const { session, modelRuntime } = await createHarnessSession({
    cwd: options.cwd,
    tools: options.tools,
    thinkingLevel: parameters.effort as string | undefined,
  });

  try {
    // Extensions register providers during binding; resolve only after that
    // registration queue has been applied to the runtime.
    const found = modelRuntime.getModel(spec.provider, spec.id);
    if (!found) {
      throw new Error(`モデルが見つかりません: ${options.model} (${spec.provider}/${spec.id})`);
    }
    const lookup = (provider: string, id: string) => modelRuntime.getModel(provider, id);
    const supportsFast = cursorPublishesFast(found.id, found.provider, lookup);
    registerRuntimeModel({ ...found, ...(supportsFast ? { supportsFast: true } : {}) } as any);
    const validated = resolveAndValidateModel(spec, `models.${options.role}`);
    const activeParameters = validated.parameters ?? {};
    const model = modelForFastParameter(found, activeParameters.fast, lookup);
    // Parameters belong to the active model invocation, not the initial session
    // configuration; apply them after selecting the model so model changes do not
    // reset the requested thinking level.
    await session.setModel({
      ...model,
      ...(typeof activeParameters.contextWindow === "number" ? { contextWindow: activeParameters.contextWindow } : {}),
    });
    // Reject unsupported levels rather than allowing the session to silently
    // coerce them to a nearby thinking level.
    const supportedThinkingLevels = model.thinkingLevelMap ? Object.keys(model.thinkingLevelMap) : (model as any).reasoning ? ["minimal", "low", "medium", "high"] : ["off"];
    if (activeParameters.effort !== undefined && !supportedThinkingLevels.includes(activeParameters.effort as string)) {
      throw new Error(`モデルが effort ${String(activeParameters.effort)} をサポートしていません`);
    }
    if (activeParameters.effort !== undefined) await session.setThinkingLevel(activeParameters.effort as any);

    // PromptOptions in SDK 0.87.1 does not forward provider stream options.
    // Apply validated parameters at the ModelRuntime boundary used by the SDK (models have no stream()).
    const { effort: _effort, contextWindow: _contextWindow, ...streamOptions } = activeParameters;
    if (Object.keys(streamOptions).length > 0) applyStreamOptions(modelRuntime as any, streamOptions);
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
