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

type ParameterRule = { values?: unknown[]; range?: [number, number]; default?: unknown; required?: boolean };
type ModelDefinition = { provider: string; id: string; parameters: Record<string, ParameterRule> };
const effort = (value: string): ParameterRule => ({ values: ["low", "medium", "high", "xhigh"], default: value });
const definitions: ModelDefinition[] = [
  { provider: "openai-codex", id: "gpt-6-astra", parameters: { effort: effort("high"), contextWindow: { range: [1, 1000000] } } },
  { provider: "openai-codex", id: "gpt-6-luna", parameters: { effort: effort("medium"), contextWindow: { range: [1, 1000000] } } },
  { provider: "cursor", id: "grok-4.6", parameters: { effort: effort("medium"), fast: { values: [true, false], default: true }, contextWindow: { range: [1, 200000] } } },
  { provider: "cursor", id: "grok-4.7", parameters: { effort: effort("medium"), fast: { values: [true, false], default: true }, contextWindow: { range: [1, 200000] } } },
  { provider: "xai", id: "grok-4.7", parameters: { effort: effort("medium"), fast: { values: [true, false], default: true }, contextWindow: { range: [1, 200000] } } },
  { provider: "anthropic", id: "claude-fable-5-1", parameters: { effort: effort("high"), contextWindow: { range: [1, 200000] } } },
];
// This registry mirrors provider catalog capabilities and is the offline preflight source.
export const modelDefinitions: Record<string, ModelDefinition> = Object.fromEntries(definitions.map((d) => [`${d.provider}/${d.id}`, d]));

export function resolveAndValidateModel(model: ModelSpec, target: string): ModelSpec {
  const definition = modelDefinitions[`${model.provider}/${model.id}`];
  if (!definition) throw new Error(`${target}: 不明なモデル ${model.provider}/${model.id}`);
  const supplied = model.parameters ?? {};
  for (const key of Object.keys(supplied)) {
    const rule = definition.parameters[key];
    if (!rule) throw new Error(`${target}: 非対応パラメータ ${key}`);
    const value = supplied[key];
    if (rule.values && !rule.values.includes(value)) throw new Error(`${target}: 非対応 ${key} ${String(value)}`);
    if (rule.range && (typeof value !== "number" || value < rule.range[0] || value > rule.range[1])) throw new Error(`${target}: ${key} が範囲外`);
  }
  const parameters: Record<string, unknown> = {};
  for (const [key, rule] of Object.entries(definition.parameters)) {
    if (rule.required && supplied[key] === undefined) throw new Error(`${target}: 必須パラメータ ${key} がありません`);
    if (rule.default !== undefined || supplied[key] !== undefined) parameters[key] = supplied[key] ?? rule.default;
  }
  return { ...model, parameters };
}
