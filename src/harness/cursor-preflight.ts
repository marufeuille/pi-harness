import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { WorkflowConfig } from "./config.ts";
import { modelCatalog } from "./models.ts";

const agentDir = path.join(fileURLToPath(new URL("../..", import.meta.url)), ".pi-clean");

type Options = { authPath?: string; apiKey?: string; fetch?: typeof fetch };

export async function validateCursorModels(config: WorkflowConfig, options: Options = {}): Promise<void> {
  const aliases = [config.models.smart, config.models.cheap].filter((alias) => alias === "grok");
  if (!aliases.length) return;
  let storedKey: string | undefined;
  try {
    const auth = JSON.parse(await fs.readFile(options.authPath ?? path.join(agentDir, "auth.json"), "utf8")) as Record<string, unknown>;
    const entry = auth.cursor;
    if (entry && typeof entry === "object" && "apiKey" in entry && typeof entry.apiKey === "string") storedKey = entry.apiKey;
  } catch { /* no stored credentials */ }
  const key = (options.apiKey || process.env.CURSOR_API_KEY || storedKey)?.trim();
  if (!key) throw new Error("Cursor 認証キーがありません (CURSOR_API_KEY または .pi-clean/auth.json)");
  let response: Response;
  try {
    response = await (options.fetch ?? fetch)("https://api.cursor.com/v0/models", { headers: { Authorization: `Bearer ${key}` } });
  } catch {
    throw new Error("Cursor のモデル一覧を取得できませんでした");
  }
  if (!response.ok) throw new Error(`Cursor のモデル一覧を取得できませんでした (HTTP ${response.status})`);
  let payload: unknown;
  try { payload = await response.json(); } catch { throw new Error("Cursor のモデル一覧を読み取れませんでした"); }
  const models = payload && typeof payload === "object" && "models" in payload ? (payload as { models: unknown }).models : undefined;
  if (!Array.isArray(models)) throw new Error("Cursor のモデル一覧の形式が不正です");
  const ids = models.map((item) => typeof item === "string" ? item : item && typeof item === "object" && "id" in item && typeof item.id === "string" ? item.id : undefined).filter((id): id is string => Boolean(id));
  const selected = new Set(aliases.map((alias) => config.models.cursorGrokId ?? modelCatalog[alias].id));
  for (const id of selected) if (!ids.includes(id)) throw new Error(`Cursor のモデル一覧に選択 ID がありません: ${id}`);
}
