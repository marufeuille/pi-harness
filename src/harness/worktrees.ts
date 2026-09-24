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

export type IngestRef = {
  branch: string;
  path?: string;
};

export type MergeFailureKind = "conflict" | "error";

export type MergeFailure = {
  ok: false;
  reason: string;
  kind: MergeFailureKind;
  conflicts: string[];
  source: IngestRef;
  destination: IngestRef;
};

export type MergeResult = { ok: true } | MergeFailure;

export type WorktreeBranchVerification =
  | { ok: true; path: string; branch: string }
  | { ok: false; path: string; expected: string; actual: string; reason: string };

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

export async function resolveBase(repo: string, revision?: string): Promise<{ sha: string; branch: string }> {
  try {
    await runGit(repo, ["fetch", "origin", "main"]);
  } catch (error) {
    throw new Error(`origin/main の取得に失敗しました: ${error instanceof Error ? error.message : String(error)}`);
  }
  const rev = revision ?? "FETCH_HEAD";
  let sha: string;
  try {
    sha = await runGit(repo, ["rev-parse", "--verify", `${rev}^{commit}`]);
  } catch (error) {
    throw new Error(`起点リビジョン ${rev} をコミット SHA に解決できません: ${String(error)}`);
  }
  return { sha, branch: revision ? `harness/${sha.slice(0, 12)}` : "main" };
}

export async function publishBaseBranch(repo: string, branch: string, sha: string): Promise<void> {
  await runGit(repo, ["branch", branch, sha]);
  await runGit(repo, ["push", "origin", `${branch}:${branch}`]);
}

export async function openIntegrationWorktree(repo: string, runId: string, baseSha: string): Promise<Worktree> {
  const branch = `harness/${runId}/integration`;
  const worktreePath = path.join(runDirectory(repo, runId), "integration");
  await mkdir(path.dirname(worktreePath), { recursive: true });
  await runGit(repo, ["worktree", "add", "-b", branch, worktreePath, baseSha]);
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

export async function verifyWorktreeBranch(worktree: Worktree): Promise<WorktreeBranchVerification> {
  try {
    const actual = await currentBranch(worktree.path);
    if (actual === worktree.branch) {
      return { ok: true, path: worktree.path, branch: actual };
    }
    return {
      ok: false,
      path: worktree.path,
      expected: worktree.branch,
      actual,
      reason: `作業ツリーがブランチ ${worktree.branch} から外れました`,
    };
  } catch (error) {
    return {
      ok: false,
      path: worktree.path,
      expected: worktree.branch,
      actual: "",
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function mergeBranch(integration: Worktree, branch: string): Promise<MergeResult> {
  const merged = await runGitResult(integration.path, [...identity, "merge", "--no-ff", "--no-edit", branch]);
  if (merged.code === 0) {
    return { ok: true };
  }
  return ingestFailure(
    integration,
    branch,
    (merged.stderr || merged.stdout || "merge が衝突しました").trim(),
  );
}

export async function continueMerge(integration: Worktree): Promise<MergeResult> {
  const mergeHead = await runGitResult(integration.path, ["rev-parse", "-q", "--verify", "MERGE_HEAD"]);
  const sourceBranch = (await mergeSourceBranch(integration.path)) ?? "";
  if (mergeHead.code !== 0) {
    return {
      ok: false,
      reason: "取り込みは進行中ではありません",
      kind: "error",
      conflicts: [],
      source: { branch: sourceBranch },
      destination: { path: integration.path, branch: integration.branch },
    };
  }

  const conflicts = await unmergedPaths(integration.path);
  if (conflicts.length > 0) {
    return ingestFailure(integration, sourceBranch, "衝突が残っています", conflicts);
  }

  const continued = await runGitResult(integration.path, [...identity, "commit", "--no-edit"]);
  if (continued.code === 0) {
    return { ok: true };
  }
  return ingestFailure(
    integration,
    sourceBranch,
    (continued.stderr || continued.stdout || "取り込みの再開に失敗しました").trim(),
  );
}

export async function removeWorktree(repo: string, worktreePath: string): Promise<void> {
  await runGit(repo, ["worktree", "remove", "--force", worktreePath]);
}

async function ingestFailure(
  integration: Worktree,
  sourceBranch: string,
  reason: string,
  conflicts?: string[],
): Promise<MergeFailure> {
  const remaining = conflicts ?? (await unmergedPaths(integration.path));
  const sourcePath = await worktreePathForBranch(integration.path, sourceBranch);
  return {
    ok: false,
    reason,
    kind: remaining.length > 0 ? "conflict" : "error",
    conflicts: remaining,
    source: { branch: sourceBranch, ...(sourcePath ? { path: sourcePath } : {}) },
    destination: { path: integration.path, branch: integration.branch },
  };
}

async function unmergedPaths(cwd: string): Promise<string[]> {
  const result = await runGitResult(cwd, ["diff", "--name-only", "--diff-filter=U"]);
  if (result.code !== 0) {
    return [];
  }
  return result.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

async function mergeSourceBranch(cwd: string): Promise<string | undefined> {
  const gitPath = await runGitResult(cwd, ["rev-parse", "--git-path", "MERGE_MSG"]);
  if (gitPath.code !== 0) {
    return undefined;
  }
  const msgPath = path.isAbsolute(gitPath.stdout.trim())
    ? gitPath.stdout.trim()
    : path.resolve(cwd, gitPath.stdout.trim());
  const current = await readFile(msgPath, "utf8").catch(() => "");
  return current.match(/Merge (?:remote-tracking )?branch '([^']+)'/)?.[1];
}

async function worktreePathForBranch(cwd: string, branch: string): Promise<string | undefined> {
  if (!branch) {
    return undefined;
  }
  const listed = await runGitResult(cwd, ["worktree", "list", "--porcelain"]);
  if (listed.code !== 0) {
    return undefined;
  }
  const expected = `refs/heads/${branch}`;
  let currentPath = "";
  for (const line of listed.stdout.split("\n")) {
    if (line.startsWith("worktree ")) {
      currentPath = line.slice("worktree ".length);
    } else if (line.startsWith("branch ") && line.slice("branch ".length) === expected) {
      return currentPath;
    }
  }
  return undefined;
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
