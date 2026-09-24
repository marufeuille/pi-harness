import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type CheckFailureKind = "command-not-found" | "authentication" | "permission" | "check-failed";

export type CheckExit = {
  code: number | string | null;
  signal: string | null;
};

export type CheckSuccess = { ok: true };

export type CheckFailure = {
  ok: false;
  command: string;
  exit: CheckExit;
  output: string;
  kind: CheckFailureKind;
};

export type CheckResult = CheckSuccess | CheckFailure;

export function isEnvironmentFailure(result: CheckFailure | CheckFailureKind): boolean {
  const kind = typeof result === "string" ? result : result.kind;
  return kind === "command-not-found" || kind === "authentication" || kind === "permission";
}

export async function runChecks(cwd: string, commands: string[]): Promise<CheckResult> {
  const chunks: string[] = [];

  for (const command of commands) {
    try {
      const { stdout, stderr } = await execFileAsync("sh", ["-c", command], {
        cwd,
        encoding: "utf8",
      });
      chunks.push(`$ ${command}\n${stdout}${stderr}`);
    } catch (error) {
      const failure = error as {
        code?: number | string;
        signal?: string | null;
        stdout?: string;
        stderr?: string;
        message?: string;
      };
      const commandOutput = `${failure.stdout ?? ""}${failure.stderr ?? failure.message ?? ""}`;
      chunks.push(`$ ${command}\n${commandOutput}`);
      const exit: CheckExit = {
        code: failure.code ?? null,
        signal: failure.signal ?? null,
      };
      const output = chunks.join("\n").trim();
      return {
        ok: false,
        command,
        exit,
        output,
        kind: classifyCheckFailure(exit, output),
      };
    }
  }

  return { ok: true };
}

export function classifyCheckFailure(exit: CheckExit, output: string): CheckFailureKind {
  if (isCommandNotFound(exit, output)) {
    return "command-not-found";
  }
  if (isPermissionFailure(exit, output)) {
    return "permission";
  }
  if (looksLikeTestRunner(output)) {
    return "check-failed";
  }
  if (isAuthenticationFailure(output)) {
    return "authentication";
  }
  return "check-failed";
}

function isCommandNotFound(exit: CheckExit, output: string): boolean {
  if (exit.code === "ENOENT" || exit.code === 127 || exit.code === "127") {
    return true;
  }
  return /command not found/i.test(output) || /: (?:\d+: )?[^:\n]+: not found\b/im.test(output);
}

function isPermissionFailure(exit: CheckExit, output: string): boolean {
  if (exit.code === "EACCES" || exit.code === "EPERM" || exit.code === 126 || exit.code === "126") {
    return true;
  }
  if (looksLikeTestRunner(output)) {
    return false;
  }
  return /permission denied|operation not permitted/i.test(output);
}

function isAuthenticationFailure(output: string): boolean {
  return (
    /authentication (?:required|failed|error)/i.test(output) ||
    /not authenticated/i.test(output) ||
    /not logged in/i.test(output) ||
    /\bgh auth login\b/i.test(output) ||
    /fatal: Authentication failed/i.test(output) ||
    /could not read Username/i.test(output) ||
    /npm ERR! code E40[13]/i.test(output) ||
    /invalid (?:api[- ]?key|access token|credentials)/i.test(output) ||
    /please (?:log in|login|authenticate)/i.test(output) ||
    /no credentials (?:found|provided)/i.test(output) ||
    /認証に失敗|ログインしてください|認証されていません/.test(output)
  );
}

function looksLikeTestRunner(output: string): boolean {
  return (
    /^TAP version /m.test(output) ||
    /^not ok \d+/m.test(output) ||
    /AssertionError/.test(output) ||
    /^# (?:tests|fail|failed|pass) \d+/m.test(output) ||
    /\b(eslint|vitest|jest|pytest|mocha)\b/i.test(output)
  );
}
