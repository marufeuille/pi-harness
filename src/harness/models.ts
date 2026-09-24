export type ModelSpec = {
  provider: string;
  id: string;
  effort?: string;
  fast?: boolean;
  contextWindow?: number;
  [parameter: string]: unknown;
};

// Legacy spellings remain conveniences; explicit provider/id specifications are unrestricted here
// and are checked against the SDK's registered model at invocation time.
export const modelCatalog: Record<string, ModelSpec> = {
  astra: { provider: "openai-codex", id: "gpt-6-astra", effort: "high" },
  luna: { provider: "openai-codex", id: "gpt-6-luna", effort: "medium" },
  grok: { provider: "cursor", id: "grok-4.6", effort: "medium" },
  fable: { provider: "anthropic", id: "claude-fable-5-1", effort: "high" },
};
