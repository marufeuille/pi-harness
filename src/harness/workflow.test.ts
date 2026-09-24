import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import type { WorkflowConfig } from "./config.ts";
import type { Steps } from "./contract.ts";
import { runWorkflow } from "./workflow.ts";

const execFileAsync = promisify(execFile);

const config: WorkflowConfig = {
  models: { smart: "astra", cheap: "grok" },
  phases: {
    pullRequest: false,
    requireCi: false,
    merge: false,
    productionCheck: false,
  },
  review: { maxLoops: 3 },
  checks: [],
};

test("既定起点は別ブランチや古い main ではなく取得した origin/main に固定される", async () => {
  const repo = await initRepo();
  try {
    const oldMain = await git(repo, ["rev-parse", "main"]);
    await addCommit(repo, "remote.txt", "remote\n");
    await git(repo, ["push", "origin", "main"]);
    await git(repo, ["checkout", "-b", "other"]);
    await addCommit(repo, "other.txt", "other\n");
    const remoteHead = await git(repo, ["rev-parse", "origin/main"]);
    // Change origin after workflow resolution: the run's selected SHA must stay fixed.
    let integrationPath = "";
    const result = await runWorkflow({ repo, ticketPath: await writeTicket(), config, steps: steps({
      clarify: async () => {
        await addCommit(repo, "later.txt", "later\n");
        await git(repo, ["push", "origin", "main"]);
        return { decision: "proceed", assumptions: [] };
      },
      plan: async () => ({ assumptions: [], tasks: [{ id: "feature", title: "x", dependsOn: [], instructions: "x" }] }),
      implement: async ({ worktree }) => { integrationPath = worktree.path; },
      review: async () => ({ decision: "pass", concerns: [] }),
    }) });
    assert.equal(result.status, "ready");
    assert.ok(result.integrationPath);
    assert.equal(await git(result.integrationPath, ["rev-parse", "HEAD"]), remoteHead);
    assert.notEqual(remoteHead, oldMain);
  } finally { await rm(repo, { recursive: true, force: true }); }
});

test("指定 SHA/タグは main の更新に影響されず、PR は指定起点ブランチを使う", async () => {
  const repo = await initRepo();
  try {
    const selected = await git(repo, ["rev-parse", "HEAD"]);
    await git(repo, ["tag", "chosen"]);
    await addCommit(repo, "new.txt", "new\n");
    await git(repo, ["push", "origin", "main"]);
    let pr: { baseBranch: string; cwd: string } | undefined;
    const result = await runWorkflow({ repo, ticketPath: await writeTicket(), baseRevision: "chosen",
      config: { ...config, phases: { ...config.phases, pullRequest: true } }, steps: steps({
        clarify: async () => ({ decision: "proceed", assumptions: [] }),
        plan: async () => ({ assumptions: [], tasks: [{ id: "feature", title: "x", dependsOn: [], instructions: "x" }] }),
        implement: async () => {}, review: async () => ({ decision: "pass", concerns: [] }),
        openPullRequest: async (args) => { pr = { baseBranch: args.baseBranch, cwd: args.cwd }; return { url: "https://example.test/pr/1", number: 1 }; },
      }) });
    assert.equal(result.status, "ready");
    assert.ok(result.integrationPath);
    assert.equal(await git(result.integrationPath, ["rev-parse", "HEAD"]), selected);
    assert.ok(pr);
    assert.match(pr.baseBranch, /^harness\//);
    assert.equal(await git(repo, ["rev-parse", `refs/remotes/origin/${pr.baseBranch}`]), selected);
  } finally { await rm(repo, { recursive: true, force: true }); }
});

test("起点の取得・解決に失敗したら処理も worktree 作成も行わない", async () => {
  for (const failure of ["fetch", "revision"] as const) {
    const repo = await initRepo();
    try {
      if (failure === "fetch") await git(repo, ["remote", "set-url", "origin", path.join(repo, "missing.git")]);
      let called = false;
      await assert.rejects(runWorkflow({ repo, ticketPath: await writeTicket(), ...(failure === "revision" ? { baseRevision: "missing-revision" } : {}), config,
        steps: steps({ clarify: async () => { called = true; return { decision: "proceed", assumptions: [] }; },
          plan: async () => { called = true; throw new Error("unexpected"); },
          implement: async () => { called = true; }, openPullRequest: async () => { called = true; throw new Error("unexpected"); } }) }),
      failure === "fetch" ? /取得に失敗/ : /解決できません/);
      assert.equal(called, false);
      assert.deepEqual(await git(repo, ["worktree", "list", "--porcelain"]).then((s) => s.split("\\n").filter((x) => x.startsWith("worktree ")).length), 1);
    } finally { await rm(repo, { recursive: true, force: true }); }
  }
});

test("曖昧ならプランも実装も始めない", async () => {
  const repo = await initRepo();
  try {
    const ticketPath = path.join(repo, "ticket.md");
    await writeFile(ticketPath, "# 未定\n\n何かいい感じにして\n");
    let planned = false;
    const result = await runWorkflow({
      repo,
      ticketPath,
      config,
      steps: steps({
        clarify: async () => ({ decision: "return", questions: ["入出力は何か"] }),
        plan: async () => {
          planned = true;
          throw new Error("plan は呼ばれない");
        },
      }),
    });
    assert.equal(result.status, "returned");
    assert.equal(planned, false);
    if (result.status === "returned") {
      assert.deepEqual(result.questions, ["入出力は何か"]);
    }
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("依存のないタスクは worktree で重ね、依存タスクは取り込み後に走る", async () => {
  const repo = await initRepo();
  try {
    const ticketPath = await writeTicket();
    let active = 0;
    let maxActive = 0;
    const result = await runWorkflow({
      repo,
      ticketPath,
      config,
      steps: steps({
        clarify: async () => ({ decision: "proceed", assumptions: ["失敗は例外"] }),
        plan: async () => ({
          assumptions: ["既存の置き場所を使う"],
          tasks: [
            { id: "write-b", title: "b", dependsOn: [], instructions: "b" },
            { id: "write-a", title: "a", dependsOn: [], instructions: "a" },
            { id: "write-c", title: "c", dependsOn: ["write-a", "write-b"], instructions: "c" },
          ],
        }),
        implement: async ({ task, worktree }) => {
          active += 1;
          maxActive = Math.max(maxActive, active);
          if (task.id === "write-c") {
            await readFile(path.join(worktree.path, "a.txt"), "utf8");
            await readFile(path.join(worktree.path, "b.txt"), "utf8");
          }
          await new Promise((resolve) => setTimeout(resolve, 40));
          const name = task.id.replace("write-", "");
          await writeFile(path.join(worktree.path, `${name}.txt`), name);
          active -= 1;
        },
        review: async () => ({ decision: "pass", concerns: ["文言は後で見てよい"] }),
      }),
    });

    assert.equal(result.status, "ready");
    assert.equal(maxActive, 2);
    assert.ok(result.integrationPath);
    assert.equal(await readFile(path.join(result.integrationPath, "c.txt"), "utf8"), "c");
    const status = await execFileAsync("git", ["status", "--porcelain"], { cwd: repo, encoding: "utf8" });
    assert.equal(status.stdout, "");
    if (result.status === "ready") {
      assert.deepEqual(result.concerns, ["文言は後で見てよい"]);
    }
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("同じファイルを触る並列タスクは衝突として人に返す", async () => {
  const repo = await initRepo();
  try {
    const result = await runWorkflow({
      repo,
      ticketPath: await writeTicket(),
      config,
      steps: steps({
        clarify: async () => ({ decision: "proceed", assumptions: [] }),
        plan: async () => ({
          assumptions: [],
          tasks: [
            { id: "left", title: "left", dependsOn: [], instructions: "left" },
            { id: "right", title: "right", dependsOn: [], instructions: "right" },
          ],
        }),
        implement: async ({ task, worktree }) => {
          await writeFile(path.join(worktree.path, "shared.txt"), task.id);
        },
        review: async () => {
          throw new Error("衝突したら検品まで進まない");
        },
      }),
    });
    assert.equal(result.status, "escalated");
    if (result.status === "escalated") {
      assert.match(result.reason, /衝突/);
    }
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("チェック失敗は安いモデルの修正タスクになり、直ったら検品へ進む", async () => {
  const repo = await initRepo();
  try {
    let reviews = 0;
    const result = await runWorkflow({
      repo,
      ticketPath: await writeTicket(),
      config: { ...config, review: { maxLoops: 2 }, checks: ["test -f marker"] },
      steps: steps({
        clarify: async () => ({ decision: "proceed", assumptions: [] }),
        plan: async () => ({
          assumptions: [],
          tasks: [{ id: "feature", title: "機能", dependsOn: [], instructions: "機能" }],
        }),
        implement: async ({ task, worktree }) => {
          if (task.id === "checks-1") {
            await writeFile(path.join(worktree.path, "marker"), "ok");
          }
        },
        review: async () => {
          reviews += 1;
          return { decision: "pass", concerns: [] };
        },
      }),
    });
    assert.equal(reviews, 1);
    assert.equal(result.status, "ready");
    assert.ok(result.integrationPath);
    assert.equal(await readFile(path.join(result.integrationPath, "marker"), "utf8"), "ok");
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("各段階の profiler jsonl を段階名とファイル名を保って保存する", async () => {
  const repo = await initRepo();
  const expected = new Map<string, { cwd: string; name: string; content: string }>();
  const createLog = async (label: string, cwd: string) => {
    const name = `${label}.jsonl`;
    const content = `{"stage":"${label}","tool":"read"}\\n`;
    const directory = path.join(cwd, ".pi-observability");
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, name), content);
    expected.set(label, { cwd, name, content });
  };
  try {
    const oldDirectory = path.join(repo, ".pi-observability");
    await mkdir(oldDirectory, { recursive: true });
    await writeFile(path.join(oldDirectory, "old.jsonl"), "old");
    await writeFile(path.join(oldDirectory, "notes.txt"), "not a log");
    const result = await runWorkflow({
      repo,
      ticketPath: await writeTicket(),
      config,
      steps: steps({
        clarify: async ({ cwd }) => {
          await createLog("clarify", cwd);
          return { decision: "proceed", assumptions: [] };
        },
        plan: async ({ cwd }) => {
          await createLog("plan", cwd);
          return { assumptions: [], tasks: [{ id: "feature", title: "機能", dependsOn: [], instructions: "機能" }] };
        },
        implement: async ({ worktree, task }) => createLog(task.id, worktree.path),
        review: async ({ cwd }) => {
          await createLog("review-1", cwd);
          return { decision: "pass", concerns: [] };
        },
      }),
    });
    assert.equal(result.status, "ready");
    for (const [label, log] of expected) {
      const archived = path.join(result.runDir, "observability", label);
      assert.deepEqual(await readdir(archived), [log.name]);
      assert.equal(await readFile(path.join(archived, log.name), "utf8"), log.content);
    }
    assert.deepEqual(await readdir(path.join(result.runDir, "observability", "clarify")), ["clarify.jsonl"]);
    const taskLog = expected.get("feature");
    assert.ok(taskLog);
    await assert.rejects(readdir(taskLog.cwd));
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("PR 以降は設定がオンのときだけ、その順で呼ぶ", async () => {
  const repo = await initRepo();
  const called: string[] = [];
  try {
    const result = await runWorkflow({
      repo,
      ticketPath: await writeTicket(),
      config: {
        ...config,
        phases: { pullRequest: true, requireCi: true, merge: true, productionCheck: true },
        productionCheckCommand: "true",
      },
      steps: steps({
        clarify: async () => ({ decision: "proceed", assumptions: ["推測A"] }),
        plan: async () => ({
          assumptions: [],
          tasks: [{ id: "feature", title: "機能", dependsOn: [], instructions: "機能" }],
        }),
        implement: async ({ worktree }) => {
          await writeFile(path.join(worktree.path, "feature.txt"), "ok");
        },
        review: async () => ({ decision: "pass", concerns: [] }),
        openPullRequest: async () => {
          called.push("pr");
          return { url: "https://example.com/pull/7", number: 7 };
        },
        waitForChecks: async () => {
          called.push("ci");
        },
        merge: async () => {
          called.push("merge");
        },
        checkProduction: async () => {
          called.push("production");
          return { decision: "ok", summary: "本番は応答した" };
        },
      }),
    });
    assert.deepEqual(called, ["pr", "ci", "merge", "production"]);
    assert.equal(result.status, "production-ok");
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

function steps(overrides: Partial<Steps>): Steps {
  const unexpected = (name: string): Promise<never> => Promise.reject(new Error(`${name} は呼ばれない`));
  return {
    clarify: () => unexpected("clarify"),
    plan: () => unexpected("plan"),
    implement: () => unexpected("implement"),
    review: () => unexpected("review"),
    openPullRequest: () => unexpected("openPullRequest"),
    waitForChecks: () => unexpected("waitForChecks"),
    merge: () => unexpected("merge"),
    checkProduction: () => unexpected("checkProduction"),
    ...overrides,
  };
}

async function initRepo(): Promise<string> {
  const repo = await mkdtemp(path.join(tmpdir(), "harness-"));
  const git = (args: string[]) =>
    execFileAsync("git", ["-c", "user.name=test", "-c", "user.email=test@example.com", ...args], { cwd: repo });
  await git(["init", "-b", "main"]);
  await writeFile(path.join(repo, "README.md"), "base\n");
  await git(["add", "README.md"]);
  await git(["commit", "-m", "init"]);
  const remote = path.join(repo, ".git", "origin.git");
  await execFileAsync("git", ["init", "--bare", remote]);
  await git(["remote", "add", "origin", remote]);
  await git(["push", "-u", "origin", "main"]);
  return repo;
}

async function git(repo: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-c", "user.name=test", "-c", "user.email=test@example.com", ...args], { cwd: repo, encoding: "utf8" });
  return stdout.trim();
}

async function addCommit(repo: string, file: string, content: string): Promise<void> {
  await writeFile(path.join(repo, file), content);
  await git(repo, ["add", file]);
  await git(repo, ["commit", "-m", file]);
}

async function writeTicket(): Promise<string> {
  const ticketPath = path.join(tmpdir(), `harness-ticket-${Math.random().toString(36).slice(2)}.md`);
  await writeFile(ticketPath, "# 挨拶\n\nHello, name を返す\n");
  return ticketPath;
}
