export type GhCommand = (args: string[]) => Promise<string>;

export type MergeWaitOptions = {
  number: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  timeoutMs?: number;
  intervalMs?: number;
  /** 必須チェックがまだ無いとき、ブランチ保護の拒否をチェック待ちとみなす猶予 */
  policyGraceMs?: number;
  onWaiting?: () => void;
};

const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;
const DEFAULT_INTERVAL_MS = 5_000;
const DEFAULT_POLICY_GRACE_MS = 45_000;

type Check = { name: string; bucket: string; state: string };

export function requiredChecksStillExpected(text: string): boolean {
  const mentionsRequired =
    /required status checks are /i.test(text) || /required status check "[^"]+" is /i.test(text);
  if (!mentionsRequired || /\bfailing\b/i.test(text)) {
    return false;
  }
  return /\b(expected|pending|in progress)\b/i.test(text);
}

export function mergeBlockedByPolicy(text: string): boolean {
  return /base branch policy prohibits the merge/i.test(text);
}

export async function mergePullRequestWhenReady(gh: GhCommand, options: MergeWaitOptions): Promise<void> {
  const number = String(options.number);
  const sleep = options.sleep ?? delay;
  const now = options.now ?? Date.now;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
  const policyGraceMs = options.policyGraceMs ?? DEFAULT_POLICY_GRACE_MS;
  const started = now();
  const deadline = started + timeoutMs;
  let announced = false;
  let policyError: unknown;

  const announce = () => {
    if (announced) return;
    announced = true;
    options.onWaiting?.();
  };

  const mergeArgs = ["pr", "merge", number, "--merge"];
  try {
    await gh(mergeArgs);
    return;
  } catch (error) {
    const text = commandFailureText(error);
    if (requiredChecksStillExpected(text)) {
      announce();
    } else if (mergeBlockedByPolicy(text)) {
      policyError = error;
      announce();
    } else {
      throw error;
    }
  }

  while (now() <= deadline) {
    const checks = await readRequiredChecks(gh, number);
    if (checks === "missing") {
      if (policyError && now() > started + policyGraceMs) {
        throw policyError;
      }
      await sleep(intervalMs);
      continue;
    }

    const failed = checks.filter((check) => check.bucket === "fail" || check.bucket === "cancel");
    if (failed.length > 0) {
      throw new Error(`必須のステータスチェックが失敗しました: ${failed.map(formatCheck).join(", ")}`);
    }

    if (!checksReady(checks)) {
      policyError = undefined;
      await sleep(intervalMs);
      continue;
    }

    try {
      await gh(mergeArgs);
      return;
    } catch (error) {
      const text = commandFailureText(error);
      if (requiredChecksStillExpected(text)) {
        await sleep(intervalMs);
        continue;
      }
      throw error;
    }
  }

  throw new Error("必須のステータスチェックが完了する前に待ち時間を超えました");
}

async function readRequiredChecks(gh: GhCommand, number: string): Promise<Check[] | "missing"> {
  try {
    const stdout = await gh(["pr", "checks", number, "--required", "--json", "name,bucket,state"]);
    return parseChecks(stdout);
  } catch (error) {
    if (checksNotReportedYet(commandFailureText(error))) {
      return "missing";
    }
    throw error;
  }
}

function checksReady(checks: Check[]): boolean {
  return checks.length > 0 && checks.every((check) => check.bucket === "pass" || check.bucket === "skipping");
}

function checksNotReportedYet(text: string): boolean {
  return /no (required )?checks reported on the /i.test(text);
}

function parseChecks(stdout: string): Check[] {
  const value: unknown = JSON.parse(stdout);
  if (!Array.isArray(value)) {
    throw new Error("ステータスチェックの一覧を読めませんでした");
  }
  return value.flatMap((item) => {
    if (typeof item !== "object" || item === null) return [];
    const record = item as Record<string, unknown>;
    return [
      {
        name: typeof record.name === "string" ? record.name : "check",
        bucket: typeof record.bucket === "string" ? record.bucket : "",
        state: typeof record.state === "string" ? record.state : "",
      },
    ];
  });
}

function formatCheck(check: Check): string {
  return `${check.name} (${check.state || check.bucket})`;
}

export function commandFailureText(error: unknown): string {
  if (typeof error === "object" && error !== null) {
    const failure = error as { stdout?: unknown; stderr?: unknown; message?: unknown };
    return [failure.stderr, failure.stdout, failure.message].filter((part) => typeof part === "string").join("\n");
  }
  return String(error);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
