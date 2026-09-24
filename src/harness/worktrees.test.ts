import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import {
  commitAll,
  continueMerge,
  currentBranch,
  mergeBranch,
  openIntegrationWorktree,
  openTaskWorktree,
  runGit,
  verifyWorktreeBranch,
} from "./worktrees.ts";

const execFileAsync = promisify(execFile);

test("既存作業ツリーが期待ブランチにいるかを検証し、外れていても作り直さない", async () => {
  const repo = await initRepo();
  try {
    const integration = await openIntegrationWorktree(repo, "run-branch", await runGit(repo, ["rev-parse", "HEAD"]));
    const task = await openTaskWorktree(repo, "run-branch", "feature", integration.branch);
    const ok = await verifyWorktreeBranch(task);
    assert.deepEqual(ok, { ok: true, path: task.path, branch: task.branch });

    await runGit(task.path, ["checkout", "-B", "other"]);
    const drifted = await verifyWorktreeBranch(task);
    assert.equal(drifted.ok, false);
    if (drifted.ok) return;
    assert.equal(drifted.path, task.path);
    assert.equal(drifted.expected, task.branch);
    assert.equal(drifted.actual, "other");
    assert.match(drifted.reason, /外れました/);
    assert.equal(await currentBranch(task.path), "other");
    await access(task.path);
    assert.match(await runGit(repo, ["branch", "--list", task.branch]), new RegExp(task.branch));
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("取り込み衝突では対象と元先を残し、作業ツリーもブランチも捨てない", async () => {
  const repo = await initRepo();
  try {
    const { integration, task } = await prepareConflict(repo, "run-conflict");
    const merged = await mergeBranch(integration, task.branch);
    assert.equal(merged.ok, false);
    if (merged.ok) return;
    assert.equal(merged.kind, "conflict");
    assert.deepEqual(merged.conflicts, ["shared.txt"]);
    assert.equal(merged.source.branch, task.branch);
    assert.equal(await realpath(merged.source.path ?? ""), await realpath(task.path));
    assert.equal(merged.destination.branch, integration.branch);
    assert.equal(await realpath(merged.destination.path ?? ""), await realpath(integration.path));
    assert.match(merged.reason, /conflict/i);
    assert.equal((await runGit(integration.path, ["rev-parse", "-q", "--verify", "MERGE_HEAD"])).length > 0, true);
    await access(task.path);
    await access(integration.path);
    assert.match(await runGit(repo, ["branch", "--list", task.branch]), new RegExp(task.branch));
    assert.match(await runGit(repo, ["branch", "--list", integration.branch]), new RegExp(integration.branch));
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("衝突が残っているあいだは再開せず、人が解消して追加したあとだけ取り込む", async () => {
  const repo = await initRepo();
  try {
    const { integration, task } = await prepareConflict(repo, "run-resume");
    const merged = await mergeBranch(integration, task.branch);
    assert.equal(merged.ok, false);

    const blocked = await continueMerge(integration);
    assert.equal(blocked.ok, false);
    if (blocked.ok) return;
    assert.equal(blocked.kind, "conflict");
    assert.deepEqual(blocked.conflicts, ["shared.txt"]);
    assert.equal(blocked.source.branch, task.branch);
    assert.equal(blocked.destination.path, integration.path);
    assert.match(await readConflictMarkers(integration.path, "shared.txt"), /<<<<<<</);

    await writeFile(path.join(integration.path, "shared.txt"), "resolved\n");
    await runGit(integration.path, ["add", "shared.txt"]);
    const resumed = await continueMerge(integration);
    assert.deepEqual(resumed, { ok: true });
    assert.equal(await currentBranch(integration.path), integration.branch);
    assert.equal(await runGit(integration.path, ["show", ":shared.txt"]), "resolved");
    await assert.rejects(runGit(integration.path, ["rev-parse", "-q", "--verify", "MERGE_HEAD"]));
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("衝突のない取り込みはこれまでどおり成功する", async () => {
  const repo = await initRepo();
  try {
    const integration = await openIntegrationWorktree(repo, "run-ok", await runGit(repo, ["rev-parse", "HEAD"]));
    const task = await openTaskWorktree(repo, "run-ok", "feature", integration.branch);
    await writeFile(path.join(task.path, "feature.txt"), "ok\n");
    assert.equal(await commitAll(task.path, "feature"), true);
    assert.deepEqual(await mergeBranch(integration, task.branch), { ok: true });
    assert.equal(await runGit(integration.path, ["show", ":feature.txt"]), "ok");
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("進行中でない取り込み再開は衝突解消をせずエラーにする", async () => {
  const repo = await initRepo();
  try {
    const integration = await openIntegrationWorktree(repo, "run-idle", await runGit(repo, ["rev-parse", "HEAD"]));
    const idle = await continueMerge(integration);
    assert.equal(idle.ok, false);
    if (idle.ok) return;
    assert.equal(idle.kind, "error");
    assert.deepEqual(idle.conflicts, []);
    assert.equal(idle.destination.path, integration.path);
    assert.match(idle.reason, /進行中ではありません/);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

async function prepareConflict(repo: string, runId: string): Promise<{
  integration: Awaited<ReturnType<typeof openIntegrationWorktree>>;
  task: Awaited<ReturnType<typeof openTaskWorktree>>;
}> {
  const integration = await openIntegrationWorktree(repo, runId, await runGit(repo, ["rev-parse", "HEAD"]));
  const task = await openTaskWorktree(repo, runId, "left", integration.branch);
  await writeFile(path.join(task.path, "shared.txt"), "task\n");
  assert.equal(await commitAll(task.path, "task"), true);
  await writeFile(path.join(integration.path, "shared.txt"), "integration\n");
  assert.equal(await commitAll(integration.path, "integration"), true);
  return { integration, task };
}

async function readConflictMarkers(worktreePath: string, file: string): Promise<string> {
  const { stdout } = await execFileAsync("cat", [path.join(worktreePath, file)], { encoding: "utf8" });
  return stdout;
}

async function initRepo(): Promise<string> {
  const repo = await mkdtemp(path.join(tmpdir(), "worktrees-"));
  await execFileAsync("git", ["init", "-b", "main"], { cwd: repo });
  await execFileAsync("git", ["-c", "user.name=test", "-c", "user.email=test@example.com", "commit", "--allow-empty", "-m", "init"], {
    cwd: repo,
  });
  return repo;
}
