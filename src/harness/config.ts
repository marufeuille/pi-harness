import { readFile } from "node:fs/promises";
import { modelCatalog, type ModelSpec } from "./models.ts";

export type WorkflowConfig = {
  models: { smart: ModelSpec; cheap: ModelSpec; cursorGrokId?: string };
  phases: { pullRequest: boolean; requireCi: boolean; merge: boolean; productionCheck: boolean };
  review: { maxLoops: number };
  checks: string[];
  productionCheckCommand?: string;
};
export async function loadConfig(configPath: string): Promise<WorkflowConfig> { return parseConfig(JSON.parse(await readFile(configPath, "utf8")) as unknown); }
export function parseConfig(raw: unknown): WorkflowConfig {
  const record = asRecord(raw, "設定"), models = asRecord(record.models, "models"), phases = asRecord(record.phases, "phases"), review = asRecord(record.review, "review");
  const config: WorkflowConfig = { models: { smart: model(models.smart, "models.smart"), cheap: model(models.cheap, "models.cheap"), ...(models.cursorGrokId === undefined ? {} : { cursorGrokId: nonempty(models.cursorGrokId, "models.cursorGrokId") }) }, phases: { pullRequest: flag(phases.pullRequest, "phases.pullRequest"), requireCi: flag(phases.requireCi, "phases.requireCi"), merge: flag(phases.merge, "phases.merge"), productionCheck: flag(phases.productionCheck, "phases.productionCheck") }, review: { maxLoops: positive(review.maxLoops, "review.maxLoops") }, checks: list(record.checks ?? [], "checks") };
  if (typeof record.productionCheckCommand === "string" && record.productionCheckCommand) config.productionCheckCommand = record.productionCheckCommand;
  if (config.phases.requireCi && !config.phases.pullRequest) throw new Error("phases.requireCi requires phases.pullRequest");
  if (config.phases.merge && !config.phases.pullRequest) throw new Error("phases.merge requires phases.pullRequest");
  if (config.phases.productionCheck && !config.phases.merge) throw new Error("phases.productionCheck requires phases.merge");
  if (config.phases.productionCheck && !config.productionCheckCommand) throw new Error("phases.productionCheck requires productionCheckCommand");
  return config;
}
function model(value: unknown, label: string): ModelSpec {
  if (typeof value === "string" && modelCatalog[value]) return { ...modelCatalog[value] };
  const v = asRecord(value, label);
  if (typeof v.provider !== "string" || !v.provider.trim()) throw new Error(`${label}.provider must be a non-empty string`);
  if (typeof v.id !== "string" || !v.id.trim()) throw new Error(`${label}.id must be a non-empty string`);
  let parameters: Record<string, unknown> | undefined;
  if (v.parameters !== undefined) {
    parameters = asRecord(v.parameters, `${label}.parameters`);
    if (parameters.effort !== undefined && (typeof parameters.effort !== "string" || !parameters.effort)) throw new Error(`${label}.parameters.effort must be a non-empty string`);
    if (parameters.fast !== undefined && typeof parameters.fast !== "boolean") throw new Error(`${label}.parameters.fast must be boolean`);
    if (parameters.contextWindow !== undefined && (typeof parameters.contextWindow !== "number" || !Number.isInteger(parameters.contextWindow) || parameters.contextWindow < 1)) throw new Error(`${label}.parameters.contextWindow must be a positive integer`);
  }
  return { provider: v.provider, id: v.id, ...(parameters === undefined ? {} : { parameters }) } as ModelSpec;
}
function nonempty(v: unknown, l: string): string { if (typeof v === "string" && v.trim()) return v; throw new Error(`${l} must be non-empty`); }
function flag(v: unknown,l:string):boolean { if(typeof v==="boolean")return v; throw new Error(`${l} must be boolean`); }
function positive(v:unknown,l:string):number { if(typeof v==="number"&&Number.isInteger(v)&&v>0)return v; throw new Error(`${l} must be a positive integer`); }
function list(v:unknown,l:string):string[] { if(Array.isArray(v)&&v.every(x=>typeof x==="string"))return v; throw new Error(`${l} must be strings`); }
function asRecord(v:unknown,l:string):Record<string, any> { if(typeof v!=="object"||v===null||Array.isArray(v))throw new Error(`${l} must be an object`); return v as Record<string, any>; }
