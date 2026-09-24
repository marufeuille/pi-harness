import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { WorkflowConfig } from "./config.ts";
import { resolveAndValidateModel } from "./models.ts";

const agentDir = path.join(fileURLToPath(new URL("../..", import.meta.url)), ".pi-clean");

type Options = { authPath?: string; apiKey?: string; listModels?: (apiKey: string) => Promise<unknown> };

async function sdkModels(apiKey: string): Promise<unknown> {
  const sdk = await import("@cursor/sdk");
  const cursor = (sdk as any).Cursor ?? (sdk as any).default;
  return cursor.models.list({ apiKey });
}

export async function validateCursorModels(config: WorkflowConfig, options: Options = {}): Promise<void> {
  const selectedModels = [
    resolveAndValidateModel(config.models.smart, "models.smart"),
    resolveAndValidateModel(config.models.cheap, "models.cheap"),
  ].filter((model) => model.provider === "cursor");
  if (!selectedModels.length) return;
  let storedKey: string | undefined;
  try {
    const auth = JSON.parse(await fs.readFile(options.authPath ?? path.join(agentDir, "auth.json"), "utf8")) as Record<string, any>;
    if (auth.cursor?.type === "api_key" && typeof auth.cursor.key === "string") storedKey = auth.cursor.key;
  } catch { /* no stored credentials */ }
  const key = (options.apiKey || process.env.CURSOR_API_KEY || storedKey)?.trim();
  if (!key) throw new Error("Cursor 認証キーがありません (CURSOR_API_KEY または .pi-clean/auth.json)");
  let result: unknown;
  try { result = await (options.listModels ?? sdkModels)(key); }
  catch { throw new Error("Cursor のモデル一覧を取得できませんでした"); }
  // SDK returns its model list; accept either the list itself or its documented data wrapper.
  const payload = result && typeof result === "object" && "data" in result ? (result as any).data : result;
  const models = Array.isArray(payload) ? payload : payload && typeof payload === "object" && "models" in payload ? (payload as any).models : undefined;
  if (!Array.isArray(models)) throw new Error("Cursor のモデル一覧の形式が不正です");
  const ids = models.map((item) => typeof item === "string" ? item : item && typeof item === "object" && typeof item.id === "string" ? item.id : undefined).filter((id): id is string => Boolean(id));
  const selected = new Set(selectedModels.map((model) => model.id));
  for (const id of selected) if (!ids.includes(id)) throw new Error(`Cursor のモデル一覧に選択 ID がありません: ${id}`);
}
