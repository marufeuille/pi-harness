export type ModelSpec = {
  provider: string;
  id: string;
  parameters?: { effort?: string; fast?: boolean; contextWindow?: number; [parameter: string]: unknown };
};

export const modelCatalog: Record<string, ModelSpec> = {
  astra: { provider: "openai-codex", id: "gpt-6-astra", parameters: { effort: "high" } },
  luna: { provider: "openai-codex", id: "gpt-6-luna", parameters: { effort: "medium" } },
  grok: { provider: "cursor", id: "grok-4.6", parameters: { effort: "medium" } },
  fable: { provider: "anthropic", id: "claude-fable-5-1", parameters: { effort: "high" } },
};

// Registry metadata used for offline preflight. Provider-specific APIs can extend this
// table as models are added; unknown IDs are deliberately rejected.
export const modelDefinitions: Record<string, { provider: string; defaults: ModelSpec["parameters"]; effort?: string[]; fast?: boolean; contextWindow?: [number, number]; required?: string[] }> = {
  "openai-codex/gpt-6-astra": { provider: "openai-codex", defaults: { effort: "high" }, effort: ["low", "medium", "high", "xhigh"] },
  "openai-codex/gpt-6-luna": { provider: "openai-codex", defaults: { effort: "medium" }, effort: ["low", "medium", "high", "xhigh"] },
  "cursor/grok-4.6": { provider: "cursor", defaults: { effort: "medium", fast: true }, effort: ["low", "medium", "high", "xhigh"], fast: true },
  "cursor/grok-4.7": { provider: "cursor", defaults: { effort: "medium", fast: true }, effort: ["low", "medium", "high", "xhigh"], fast: true },
  "anthropic/claude-fable-5-1": { provider: "anthropic", defaults: { effort: "high" }, effort: ["low", "medium", "high", "xhigh"] },
};

export function resolveAndValidateModel(model: ModelSpec, target: string): ModelSpec {
  const definition = modelDefinitions[`${model.provider}/${model.id}`];
  if (!definition) throw new Error(`${target}: 不明なモデル ${model.provider}/${model.id}`);
  const supplied = model.parameters ?? {};
  const allowed = new Set(["effort", "fast", "contextWindow"]);
  for (const key of Object.keys(supplied)) if (!allowed.has(key)) throw new Error(`${target}: 非対応パラメータ ${key}`);
  if (definition.required?.some((key) => supplied[key] === undefined)) throw new Error(`${target}: 必須パラメータがありません`);
  if (supplied.effort !== undefined && !definition.effort?.includes(String(supplied.effort))) throw new Error(`${target}: 非対応 effort ${String(supplied.effort)}`);
  if (supplied.fast !== undefined && definition.fast !== true) throw new Error(`${target}: 非対応 fast`);
  if (supplied.contextWindow !== undefined && (typeof supplied.contextWindow !== "number" || supplied.contextWindow < (definition.contextWindow?.[0] ?? 1) || supplied.contextWindow > (definition.contextWindow?.[1] ?? 200000))) throw new Error(`${target}: contextWindow が範囲外`);
  return { ...model, parameters: { ...definition.defaults, ...supplied } };
}
