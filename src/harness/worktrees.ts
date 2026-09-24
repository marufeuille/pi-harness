import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const identity = [
  "-c",
  "user.name=harness",
  "-c",
  "user.email=harness@localhost",
  "-c",
  "commit.gpgsign=false",
];

export type Worktree = {
  path: string;
  branch: string;
};

export type CommandResult = {
  code: number;
  stdout: string;
  stderr: string;
};

export function runDirectory(repo: string, runId: string): string {
  return path.join(repo, ".harness", "runs", runId);
}

export function createRunId(): string {
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, "");
  const suffix = Math.random().toString(36).slice(2, 6);
  return `${stamp}-${suffix}`;
}

export async function runGit(cwd: string, args: string[]): Promise<string> {
  const result = await runGitResult(cwd, args);
  if (result.code !== 0) {
    throw new Error(`git ${args.join(" ")} に失敗しました\n${result.stderr || result.stdout}`);
  }
  return result.stdout.trim();
}

export async function ensureGitRepo(repo: string): Promise<string> {
  const inside = await runGit(repo, ["rev-parse", "--is-inside-work-tree"]);
  if (inside !== "true") {
    throw new Error(`${repo} は git リポジトリではありません`);
  }
  const branch = await runGit(repo, ["rev-parse", "--abbrev-ref", "HEAD"]);
  await excludeHarness(repo);
  return branch;
}

export async function openIntegrationWorktree(repo: string, runId: string): Promise<Worktree> {
  const branch = `harness/${runId}/integration`;
  const worktreePath = path.join(runDirectory(repo, runId), "integration");
  await mkdir(path.dirname(worktreePath), { recursive: true });
  await runGit(repo, ["worktree", "add", "-b", branch, worktreePath, "HEAD"]);
  return { path: worktreePath, branch };
}

export async function openTaskWorktree(
  repo: string,
  runId: string,
  taskId: string,
  baseBranch: string,
): Promise<Worktree> {
  const branch = `harness/${runId}/task/${taskId}`;
  const worktreePath = path.join(runDirectory(repo, runId), "tasks", taskId);
  await mkdir(path.dirname(worktreePath), { recursive: true });
  await runGit(repo, ["worktree", "add", "-b", branch, worktreePath, baseBranch]);
  return { path: worktreePath, branch };
}

export async function currentBranch(cwd: string): Promise<string> {
  return runGit(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
}

export async function headSha(cwd: string): Promise<string> {
  return runGit(cwd, ["rev-parse", "HEAD"]);
}

export async function commitAll(cwd: string, message: string): Promise<boolean> {
  await runGit(cwd, ["add", "-A"]);
  const diff = await runGitResult(cwd, ["diff", "--cached", "--quiet"]);
  if (diff.code === 0) {
    return false;
  }
  if (diff.code !== 1) {
    throw new Error(`git diff に失敗しました\n${diff.stderr}`);
  }
  await runGit(cwd, [...identity, "commit", "-m", message]);
  return true;
}

export async function commitsAhead(cwd: string, baseBranch: string, branch: string): Promise<number> {
  const count = await runGit(cwd, ["rev-list", "--count", `${baseBranch}..${branch}`]);
  return Number(count);
}

export async function mergeBranch(
  integration: Worktree,
  branch: string,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const merged = await runGitResult(integration.path, [...identity, "merge", "--no-ff", "--no-edit", branch]);
  if (merged.code === 0) {
    return { ok: true };
  }
  await runGitResult(integration.path, ["merge", "--abort"]);
  return {
    ok: false,
    reason: (merged.stderr || merged.stdout || "merge が衝突しました").trim(),
  };
}

export async function removeWorktree(repo: string, worktreePath: string): Promise<void> {
  await runGit(repo, ["worktree", "remove", "--force", worktreePath]);
}

async function excludeHarness(repo: string): Promise<void> {
  const gitPath = await runGit(repo, ["rev-parse", "--git-path", "info/exclude"]);
  const excludePath = path.isAbsolute(gitPath) ? gitPath : path.resolve(repo, gitPath);
  const current = await readFile(excludePath, "utf8").catch(() => "");
  if (current.includes(".harness/")) {
    return;
  }
  await mkdir(path.dirname(excludePath), { recursive: true });
  await writeFile(excludePath, `${current.trimEnd()}\n.harness/\n`);
}

async function runGitResult(cwd: string, args: string[]): Promise<CommandResult> {
  try {
    const { stdout, stderr } = await execFileAsync("git", args, { cwd, encoding: "utf8" });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string; message?: string };
    if (typeof failure.code !== "number") {
      throw error;
    }
    return {
      code: failure.code,
      stdout: failure.stdout ?? "",
      stderr: failure.stderr ?? failure.message ?? "",
    };
  }
}
