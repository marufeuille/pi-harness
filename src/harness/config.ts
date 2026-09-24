import { readFile } from "node:fs/promises";

import { modelCatalog, type ModelAlias } from "./models.ts";

export type WorkflowConfig = {
  models: {
    smart: ModelAlias;
    cheap: ModelAlias;
    cursorGrokId?: string;
  };
  phases: {
    pullRequest: boolean;
    requireCi: boolean;
    merge: boolean;
    productionCheck: boolean;
  };
  review: {
    maxLoops: number;
  };
  checks: string[];
  productionCheckCommand?: string;
};

export async function loadConfig(configPath: string): Promise<WorkflowConfig> {
  const raw = JSON.parse(await readFile(configPath, "utf8")) as unknown;
  return parseConfig(raw);
}

export function parseConfig(raw: unknown): WorkflowConfig {
  const record = asRecord(raw, "設定");
  const models = asRecord(record.models, "models");
  const phases = asRecord(record.phases, "phases");
  const review = asRecord(record.review, "review");

  const config: WorkflowConfig = {
    models: {
      smart: alias(models.smart, "models.smart"),
      cheap: alias(models.cheap, "models.cheap"),
      ...(models.cursorGrokId === undefined
        ? {}
        : { cursorGrokId: cursorModelId(models.cursorGrokId, "models.cursorGrokId") }),
    },
    phases: {
      pullRequest: booleanFlag(phases.pullRequest, "phases.pullRequest"),
      requireCi: booleanFlag(phases.requireCi, "phases.requireCi"),
      merge: booleanFlag(phases.merge, "phases.merge"),
      productionCheck: booleanFlag(phases.productionCheck, "phases.productionCheck"),
    },
    review: {
      maxLoops: positiveInteger(review.maxLoops, "review.maxLoops"),
    },
    checks: stringList(record.checks ?? [], "checks"),
  };

  if (typeof record.productionCheckCommand === "string" && record.productionCheckCommand.length > 0) {
    config.productionCheckCommand = record.productionCheckCommand;
  }

  if (config.phases.requireCi && !config.phases.pullRequest) {
    throw new Error("phases.requireCi を有効にするには phases.pullRequest も有効にしてください");
  }
  if (config.phases.merge && !config.phases.pullRequest) {
    throw new Error("phases.merge を有効にするには phases.pullRequest も有効にしてください");
  }
  if (config.phases.productionCheck && !config.phases.merge) {
    throw new Error("phases.productionCheck を有効にするには phases.merge も有効にしてください");
  }
  if (config.phases.productionCheck && !config.productionCheckCommand) {
    throw new Error("phases.productionCheck を有効にするには productionCheckCommand が必要です");
  }

  return config;
}

function alias(value: unknown, label: string): ModelAlias {
  if (typeof value === "string" && value in modelCatalog) {
    return value as ModelAlias;
  }
  throw new Error(`${label} は ${Object.keys(modelCatalog).join(" / ")} のいずれかにしてください`);
}

function cursorModelId(value: unknown, label: string): string {
  if (typeof value === "string" && value.trim().length > 0) {
    return value;
  }
  throw new Error(`${label} は空でない文字列にしてください`);
}

function booleanFlag(value: unknown, label: string): boolean {
  if (typeof value === "boolean") {
    return value;
  }
  throw new Error(`${label} は true か false にしてください`);
}

function positiveInteger(value: unknown, label: string): number {
  if (typeof value === "number" && Number.isInteger(value) && value >= 1) {
    return value;
  }
  throw new Error(`${label} は 1 以上の整数にしてください`);
}

function stringList(value: unknown, label: string): string[] {
  if (Array.isArray(value) && value.every((item) => typeof item === "string")) {
    return value;
  }
  throw new Error(`${label} は文字列の配列にしてください`);
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} はオブジェクトにしてください`);
  }
  return value as Record<string, unknown>;
}
