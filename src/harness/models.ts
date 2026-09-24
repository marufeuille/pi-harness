export const modelCatalog = {
  astra: { provider: "openai-codex", id: "gpt-6-astra", thinking: "high" },
  luna: { provider: "openai-codex", id: "gpt-6-luna", thinking: "medium" },
  grok: { provider: "xai", id: "grok-4.7", thinking: "medium" },
  fable: { provider: "anthropic", id: "claude-fable-5-1", thinking: "high" },
} as const;

export type ModelAlias = keyof typeof modelCatalog;

export type ModelSpec = (typeof modelCatalog)[ModelAlias];
