import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import type { WorkflowConfig } from "./config.ts";
import type { Steps } from "./contract.ts";
import { loadLoopState } from "./loop-state.ts";
import { runWorkflow } from "./workflow.ts";

const execFileAsync = promisify(execFile);

const config: WorkflowConfig = {
  models: {
    smart: { provider: "openai-codex", id: "gpt-6-astra", parameters: { effort: "high" } },
    cheap: { provider: "cursor", id: "grok-4.6", parameters: { effort: "medium" } },
  },
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

test("--base 指定で停止した専用ベースは別プロセス再開後の PR でも公開する", async () => {
  const repo = await initRepo();
  const issue = { id: "fix-a", title: "境界", dependsOn: [] as string[], instructions: "空白を拒否する" };
  try {
    const selected = await git(repo, ["rev-parse", "HEAD"]);
    await git(repo, ["tag", "chosen"]);
    await addCommit(repo, "new.txt", "new\n");
    await git(repo, ["push", "origin", "main"]);
    const prConfig = { ...config, review: { maxLoops: 1 }, phases: { ...config.phases, pullRequest: true } };
    const first = await runWorkflow({
      repo,
      ticketPath: await writeTicket(),
      baseRevision: "chosen",
      config: prConfig,
      steps: steps({
        clarify: async () => ({ decision: "proceed", assumptions: [] }),
        plan: async () => ({
          assumptions: [],
          tasks: [{ id: "feature", title: "機能", dependsOn: [], instructions: "機能" }],
        }),
        implement: async () => {},
        review: async () => ({ decision: "fix", issues: [issue] }),
      }),
    });
    assert.equal(first.status, "escalated");
    if (first.status !== "escalated") throw new Error("expected stop");
    assert.equal(first.resumeState.shouldPublishBase, true);
    assert.equal(first.resumeState.baseBranch, `harness/${first.runId}/base`);
    await assert.rejects(git(repo, ["rev-parse", `refs/remotes/origin/${first.resumeState.baseBranch}`]));

    const stored = await loadLoopState(first.runDir);
    assert.equal(stored.shouldPublishBase, true);
    assert.equal(stored.baseBranch, first.resumeState.baseBranch);
    let pr: { baseBranch: string } | undefined;
    const resumed = await runWorkflow({
      repo,
      config: prConfig,
      steps: steps({
        clarify: async () => {
          throw new Error("再開で要件確認しない");
        },
        plan: async () => {
          throw new Error("再開で最初からプランしない");
        },
        implement: async () => {},
        review: async () => ({ decision: "pass", concerns: [] }),
        openPullRequest: async (args) => {
          pr = { baseBranch: args.baseBranch };
          return { url: "https://example.test/pr/1", number: 1 };
        },
      }),
      resume: { state: stored, extraRounds: 1 },
    });
    assert.equal(resumed.status, "ready");
    assert.equal(resumed.runId, first.runId);
    assert.equal(resumed.integrationPath, first.integrationPath);
    assert.ok(pr);
    assert.equal(pr.baseBranch, first.resumeState.baseBranch);
    assert.equal(await git(repo, ["rev-parse", `refs/remotes/origin/${pr.baseBranch}`]), selected);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
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
      assert.equal(result.stop.kind, "conflict");
      assert.match(result.reason, /衝突/);
      assert.match(result.stop.lastOutput, /衝突/);
      assert.equal(result.stop.worktree, result.integrationPath);
      assert.ok(result.stop.branch);
      assert.match(result.stop.recommendation, /取り込み/);
      assert.ok(result.resumeState);
      assert.ok(result.resumeState.remainingTasks.length > 0);
      assert.deepEqual(result.stop.conflicts, ["shared.txt"]);
      assert.ok(result.resumeState.completedTaskIds.includes("left"));
      assert.equal(result.resumeState.completedTaskIds.includes("right"), false);
      assert.equal(await readFile(path.join(result.runDir, "tasks", "right", "shared.txt"), "utf8"), "right");
    }
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("元プランと同じIDの指摘は通常ループと追加回数の再開で実装する", async () => {
  const repo = await initRepo();
  const issue = (id: string, dependsOn: string[] = []) => ({
    id,
    title: id,
    dependsOn,
    instructions: `${id} を直す`,
  });
  try {
    const loopedIds: string[] = [];
    let loopReviews = 0;
    const looped = await runWorkflow({
      repo,
      ticketPath: await writeTicket(),
      config: { ...config, review: { maxLoops: 3 } },
      steps: steps({
        clarify: async () => ({ decision: "proceed", assumptions: [] }),
        plan: async () => ({
          assumptions: [],
          tasks: [{ id: "feature", title: "機能", dependsOn: [], instructions: "機能" }],
        }),
        implement: async ({ task }) => {
          loopedIds.push(task.id);
        },
        review: async () => {
          loopReviews += 1;
          if (loopReviews === 1) {
            return { decision: "fix", issues: [issue("feature")] };
          }
          return { decision: "pass", concerns: [] };
        },
      }),
    });
    assert.equal(looped.status, "ready");
    assert.deepEqual(loopedIds, ["feature", "feature"]);

    const implemented: string[] = [];
    let reviews = 0;
    const first = await runWorkflow({
      repo,
      ticketPath: await writeTicket(),
      config: { ...config, review: { maxLoops: 2 } },
      steps: steps({
        clarify: async () => ({ decision: "proceed", assumptions: [] }),
        plan: async () => ({
          assumptions: [],
          tasks: [{ id: "feature", title: "機能", dependsOn: [], instructions: "機能" }],
        }),
        implement: async ({ task }) => {
          implemented.push(task.id);
        },
        review: async () => {
          reviews += 1;
          if (reviews === 1) {
            return { decision: "fix", issues: [issue("feature"), issue("extra", ["feature"])] };
          }
          return { decision: "fix", issues: [issue("feature")] };
        },
      }),
    });
    assert.equal(first.status, "escalated");
    if (first.status !== "escalated") throw new Error("expected stop");
    assert.equal(first.stop.kind, "decreasing-fatal");
    assert.deepEqual(implemented, ["feature", "feature", "extra"]);
    const resumed = await runWorkflow({
      repo,
      ticketPath: await writeTicket(),
      config: { ...config, review: { maxLoops: 2 } },
      steps: steps({
        clarify: async () => {
          throw new Error("再開で要件確認しない");
        },
        plan: async () => {
          throw new Error("再開で最初からプランしない");
        },
        implement: async ({ task }) => {
          implemented.push(task.id);
        },
        review: async () => ({ decision: "pass", concerns: [] }),
      }),
      resume: { state: first.resumeState, extraRounds: 1 },
    });
    assert.equal(resumed.status, "ready");
    assert.equal(resumed.integrationPath, first.integrationPath);
    assert.deepEqual(implemented, ["feature", "feature", "extra", "feature"]);
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
        review: async () => ({ decision: "pass", concerns: ["ログの文言は後でよい"] }),
        openPullRequest: async (args) => {
          called.push("pr");
          assert.deepEqual(args.concerns, ["ログの文言は後でよい"]);
          assert.deepEqual(args.assumptions, ["推測A"]);
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
    if (result.status === "production-ok") {
      assert.deepEqual(result.concerns, ["ログの文言は後でよい"]);
    }
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("要求を満たし懸念だけの実行は上限でも次のフェーズへ進む", async () => {
  const repo = await initRepo();
  try {
    const result = await runWorkflow({
      repo,
      ticketPath: await writeTicket(),
      config: { ...config, review: { maxLoops: 1 } },
      steps: steps({
        clarify: async () => ({ decision: "proceed", assumptions: [] }),
        plan: async () => ({
          assumptions: [],
          tasks: [{ id: "feature", title: "機能", dependsOn: [], instructions: "機能" }],
        }),
        implement: async () => {},
        review: async () => ({ decision: "pass", concerns: ["ログの文言は後でよい"] }),
      }),
    });
    assert.equal(result.status, "ready");
    if (result.status === "ready") {
      assert.deepEqual(result.concerns, ["ログの文言は後でよい"]);
    }
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("減っている致命的な残件は上限で止まり、追加回数で同じブランチの残件だけ続く", async () => {
  const repo = await initRepo();
  const issue = (id: string) => ({ id, title: id, dependsOn: [] as string[], instructions: id });
  try {
    let reviews = 0;
    let clarifies = 0;
    let plans = 0;
    const implemented: string[] = [];
    const first = await runWorkflow({
      repo,
      ticketPath: await writeTicket(),
      config: { ...config, review: { maxLoops: 2 } },
      steps: steps({
        clarify: async () => {
          clarifies += 1;
          return { decision: "proceed", assumptions: ["失敗は例外"] };
        },
        plan: async () => {
          plans += 1;
          return {
            assumptions: [],
            tasks: [{ id: "feature", title: "機能", dependsOn: [], instructions: "機能" }],
          };
        },
        implement: async ({ task }) => {
          implemented.push(task.id);
        },
        review: async () => {
          reviews += 1;
          if (reviews === 1) {
            return { decision: "fix", issues: [issue("fix-a"), issue("fix-b")] };
          }
          return { decision: "fix", issues: [issue("fix-a")] };
        },
      }),
    });
    assert.equal(first.status, "escalated");
    if (first.status !== "escalated") throw new Error("expected stop");
    assert.equal(first.stop.kind, "decreasing-fatal");
    assert.equal(first.stop.trend, "decreasing");
    assert.match(first.stop.lastOutput, /fix-a/);
    assert.equal(first.stop.worktree, first.integrationPath);
    assert.ok(first.stop.branch);
    assert.match(first.stop.recommendation, /追加回数/);
    assert.equal(first.resumeState.originalMaxLoops, 2);
    assert.equal(implemented[0], "feature");
    assert.deepEqual([...implemented.slice(1)].sort(), ["fix-a", "fix-b"]);
    const cfg = { ...config, review: { maxLoops: 2 } };
    const stored = await loadLoopState(first.runDir);
    const resumed = await runWorkflow({
      repo,
      ticketPath: await writeTicket(),
      config: cfg,
      steps: steps({
        clarify: async () => {
          clarifies += 1;
          throw new Error("再開で要件確認しない");
        },
        plan: async () => {
          plans += 1;
          throw new Error("再開で最初からプランしない");
        },
        implement: async ({ task }) => {
          implemented.push(task.id);
        },
        review: async () => ({ decision: "pass", concerns: ["文言"] }),
      }),
      resume: { state: stored, extraRounds: 1 },
    });
    assert.equal(cfg.review.maxLoops, 2);
    assert.equal(clarifies, 1);
    assert.equal(plans, 1);
    assert.equal(resumed.status, "ready");
    assert.equal(resumed.integrationPath, first.integrationPath);
    assert.equal(resumed.runId, first.runId);
    assert.equal(implemented[3], "fix-a");
    assert.deepEqual([...implemented.slice(1, 3)].sort(), ["fix-a", "fix-b"]);
    assert.equal(implemented.length, 4);
    const branches = await git(repo, ["branch"]);
    assert.equal([...branches.matchAll(/integration/g)].length, 1);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("Linear 識別情報は停止状態に残り再開後も保持される", async () => {
  const repo = await initRepo();
  try {
    const first = await runWorkflow({
      repo,
      ticket: { path: "linear:ABC-1", title: "挨拶", body: "Hello, name を返す" },
      linearIssueId: "ABC-1",
      config: { ...config, review: { maxLoops: 1 } },
      steps: steps({
        clarify: async () => ({ decision: "proceed", assumptions: [] }),
        plan: async () => ({ assumptions: [], tasks: [{ id: "feature", title: "機能", dependsOn: [], instructions: "機能" }] }),
        implement: async () => {},
        review: async () => ({ decision: "fix", issues: [{ id: "fix-a", title: "境界", dependsOn: [], instructions: "直す" }] }),
      }),
    });
    assert.equal(first.status, "escalated");
    if (first.status !== "escalated") throw new Error("expected stop");
    assert.equal(first.resumeState.linearIssueId, "ABC-1");
    const stored = await loadLoopState(first.runDir);
    assert.equal(stored.linearIssueId, "ABC-1");
    const second = await runWorkflow({
      repo,
      config: { ...config, review: { maxLoops: 1 } },
      steps: steps({
        implement: async () => {},
        review: async () => ({ decision: "fix", issues: [{ id: "fix-a", title: "境界", dependsOn: [], instructions: "直す" }] }),
      }),
      resume: { state: stored, extraRounds: 1 },
    });
    assert.equal(second.status, "escalated");
    if (second.status !== "escalated") throw new Error("expected stop");
    assert.equal(second.resumeState.linearIssueId, "ABC-1");
    assert.equal((await loadLoopState(first.runDir)).linearIssueId, "ABC-1");
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("同じ指摘が続くと残り周を使わず止まり、回数追加の再開はできない", async () => {
  const repo = await initRepo();
  const issue = { id: "fix-a", title: "境界", dependsOn: [] as string[], instructions: "空白を拒否する" };
  try {
    let reviews = 0;
    const implemented: string[] = [];
    const result = await runWorkflow({
      repo,
      ticketPath: await writeTicket(),
      config: { ...config, review: { maxLoops: 3 } },
      steps: steps({
        clarify: async () => ({ decision: "proceed", assumptions: [] }),
        plan: async () => ({
          assumptions: [],
          tasks: [{ id: "feature", title: "機能", dependsOn: [], instructions: "機能" }],
        }),
        implement: async ({ task }) => {
          implemented.push(task.id);
        },
        review: async () => {
          reviews += 1;
          return { decision: "fix", issues: [issue] };
        },
      }),
    });
    assert.equal(reviews, 2);
    assert.deepEqual(implemented, ["feature", "fix-a"]);
    assert.equal(result.status, "escalated");
    if (result.status !== "escalated") throw new Error("expected stop");
    assert.equal(result.stop.kind, "stalled");
    assert.equal(result.stop.trend, "same");
    assert.match(result.stop.recommendation, /ヒント|プラン/);
    assert.equal(result.stop.recommendation.includes("追加回数"), false);
    await assert.rejects(
      runWorkflow({
        repo,
        ticketPath: await writeTicket(),
        config,
        steps: steps({
          clarify: async () => ({ decision: "proceed", assumptions: [] }),
        }),
        resume: { state: result.resumeState, extraRounds: 2 },
      }),
      /追加回数/,
    );
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("停滞からの再開はヒントを残件に足すか残件だけ再プランする", async () => {
  const repo = await initRepo();
  const issue = { id: "fix-a", title: "境界", dependsOn: [] as string[], instructions: "空白を拒否する" };
  try {
    const stalled = await runWorkflow({
      repo,
      ticketPath: await writeTicket(),
      config: { ...config, review: { maxLoops: 3 } },
      steps: steps({
        clarify: async () => ({ decision: "proceed", assumptions: [] }),
        plan: async () => ({
          assumptions: [],
          tasks: [{ id: "feature", title: "機能", dependsOn: [], instructions: "機能" }],
        }),
        implement: async () => {},
        review: async () => ({ decision: "fix", issues: [issue] }),
      }),
    });
    if (stalled.status !== "escalated") throw new Error("expected stop");
    const hintedIds: string[] = [];
    let hintedInstructions = "";
    const hinted = await runWorkflow({
      repo,
      ticketPath: await writeTicket(),
      config,
      steps: steps({
        clarify: async () => {
          throw new Error("再開で要件確認しない");
        },
        plan: async () => {
          throw new Error("ヒント再開では再プランしない");
        },
        implement: async ({ task }) => {
          hintedIds.push(task.id);
          hintedInstructions = task.instructions;
        },
        review: async () => ({ decision: "pass", concerns: [] }),
      }),
      resume: { state: stalled.resumeState, hint: "既存テストを壊さない" },
    });
    assert.equal(hinted.status, "ready");
    assert.deepEqual(hintedIds, ["fix-a"]);
    assert.match(hintedInstructions, /既存テストを壊さない/);

    const stalledAgain = await runWorkflow({
      repo,
      ticketPath: await writeTicket(),
      config: { ...config, review: { maxLoops: 3 } },
      steps: steps({
        clarify: async () => ({ decision: "proceed", assumptions: [] }),
        plan: async () => ({
          assumptions: [],
          tasks: [{ id: "feature", title: "機能", dependsOn: [], instructions: "機能" }],
        }),
        implement: async () => {},
        review: async () => ({ decision: "fix", issues: [issue] }),
      }),
    });
    if (stalledAgain.status !== "escalated") throw new Error("expected stop");
    const planned: string[][] = [];
    const implemented: string[] = [];
    const replanned = await runWorkflow({
      repo,
      ticketPath: await writeTicket(),
      config,
      steps: steps({
        clarify: async () => {
          throw new Error("再開で要件確認しない");
        },
        plan: async ({ remaining }) => {
          planned.push((remaining ?? []).map((task) => task.id));
          return {
            assumptions: ["残件だけ"],
            tasks: [{ id: "replan-1", title: "残件", dependsOn: [], instructions: "残件だけ直す" }],
          };
        },
        implement: async ({ task }) => {
          implemented.push(task.id);
        },
        review: async () => ({ decision: "pass", concerns: [] }),
      }),
      resume: { state: stalledAgain.resumeState, replanRemaining: true },
    });
    assert.equal(replanned.status, "ready");
    assert.deepEqual(planned, [["fix-a"]]);
    assert.deepEqual(implemented, ["replan-1"]);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("要求不足の検品は質問を返し、回答は仮定として同じブランチの続きになる", async () => {
  const repo = await initRepo();
  try {
    const first = await runWorkflow({
      repo,
      ticketPath: await writeTicket(),
      config,
      steps: steps({
        clarify: async () => ({ decision: "proceed", assumptions: ["名前は必須"] }),
        plan: async () => ({
          assumptions: [],
          tasks: [{ id: "feature", title: "機能", dependsOn: [], instructions: "機能" }],
        }),
        implement: async () => {},
        review: async () => ({ decision: "return", questions: ["失敗時の戻り値は何か"] }),
      }),
    });
    assert.equal(first.status, "returned");
    if (first.status !== "returned") throw new Error("expected questions");
    assert.deepEqual(first.questions, ["失敗時の戻り値は何か"]);
    assert.equal(first.stop?.kind, "insufficient-requirements");
    assert.ok(first.resumeState);
    assert.ok(first.integrationPath);
    const resumed = await runWorkflow({
      repo,
      ticketPath: await writeTicket(),
      config,
      steps: steps({
        clarify: async () => {
          throw new Error("再開で要件確認しない");
        },
        plan: async () => {
          throw new Error("回答再開では再プランしない");
        },
        implement: async () => {
          throw new Error("残件が空なら実装しない");
        },
        review: async ({ plan }) => {
          assert.ok(plan.assumptions.includes("400 を返す"));
          return { decision: "pass", concerns: [] };
        },
      }),
      resume: { state: first.resumeState, answers: ["400 を返す"] },
    });
    assert.equal(resumed.status, "ready");
    assert.equal(resumed.integrationPath, first.integrationPath);
    if (resumed.status === "ready") {
      assert.ok(resumed.assumptions.includes("400 を返す"));
      assert.ok(resumed.assumptions.includes("名前は必須"));
    }
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("作業ツリーのブランチ逸脱は修正ループとは別の種類で止まる", async () => {
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
          tasks: [{ id: "feature", title: "機能", dependsOn: [], instructions: "機能" }],
        }),
        implement: async ({ worktree }) => {
          await execFileAsync("git", ["checkout", "-b", "drift"], { cwd: worktree.path });
        },
        review: async () => {
          throw new Error("逸脱したら検品まで進まない");
        },
      }),
    });
    assert.equal(result.status, "escalated");
    if (result.status === "escalated") {
      assert.equal(result.stop.kind, "branch-deviation");
      assert.match(result.stop.lastOutput, /外れました/);
      assert.match(result.stop.recommendation, /取り込み/);
    }
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("環境由来のチェック失敗は修正ループとは別の種類で止まる", async () => {
  const repo = await initRepo();
  try {
    const implemented: string[] = [];
    const result = await runWorkflow({
      repo,
      ticketPath: await writeTicket(),
      config: { ...config, review: { maxLoops: 3 }, checks: ["__harness_missing_cmd_xyz__"] },
      steps: steps({
        clarify: async () => ({ decision: "proceed", assumptions: [] }),
        plan: async () => ({
          assumptions: [],
          tasks: [{ id: "feature", title: "機能", dependsOn: [], instructions: "機能" }],
        }),
        implement: async ({ task }) => {
          implemented.push(task.id);
        },
        review: async () => {
          throw new Error("環境失敗は検品しない");
        },
      }),
    });
    assert.deepEqual(implemented, ["feature"]);
    assert.equal(result.status, "escalated");
    if (result.status === "escalated") {
      assert.equal(result.stop.kind, "environment-check");
      assert.match(result.stop.lastOutput, /not found|command not found/i);
      assert.match(result.stop.recommendation, /取り込み/);
    }
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("同じチェック失敗は早期停止し、中身が変わるチェックは上限まで続ける", async () => {
  const repo = await initRepo();
  try {
    const sameImplemented: string[] = [];
    const same = await runWorkflow({
      repo,
      ticketPath: await writeTicket(),
      config: { ...config, review: { maxLoops: 3 }, checks: ["sh -c 'echo same-fail; exit 1'"] },
      steps: steps({
        clarify: async () => ({ decision: "proceed", assumptions: [] }),
        plan: async () => ({
          assumptions: [],
          tasks: [{ id: "feature", title: "機能", dependsOn: [], instructions: "機能" }],
        }),
        implement: async ({ task }) => {
          sameImplemented.push(task.id);
        },
        review: async () => {
          throw new Error("同じ失敗では検品しない");
        },
      }),
    });
    assert.equal(same.status, "escalated");
    if (same.status === "escalated") {
      assert.equal(same.stop.kind, "stalled");
      assert.equal(same.stop.trend, "same");
      assert.match(same.stop.lastOutput, /same-fail/);
    }
    assert.equal(sameImplemented.filter((id) => id.startsWith("checks-")).length, 1);

    const changeImplemented: string[] = [];
    let reviews = 0;
    const changingCheck =
      "sh -c 'i=0; [ -f .check-n ] && i=$(cat .check-n); i=$((i+1)); echo $i > .check-n; echo fail-$i; exit 1'";
    const changing = await runWorkflow({
      repo,
      ticketPath: await writeTicket(),
      config: { ...config, review: { maxLoops: 3 }, checks: [changingCheck] },
      steps: steps({
        clarify: async () => ({ decision: "proceed", assumptions: [] }),
        plan: async () => ({
          assumptions: [],
          tasks: [{ id: "feature", title: "機能", dependsOn: [], instructions: "機能" }],
        }),
        implement: async ({ task }) => {
          changeImplemented.push(task.id);
        },
        review: async () => {
          reviews += 1;
          return { decision: "fix", issues: [{ id: "still", title: "still", dependsOn: [], instructions: "still" }] };
        },
      }),
    });
    assert.equal(reviews, 1);
    assert.equal(changeImplemented.filter((id) => id.startsWith("checks-")).length, 2);
    assert.equal(changing.status, "escalated");
    if (changing.status === "escalated") {
      assert.equal(changing.stop.kind, "changing");
      assert.equal(changing.stop.trend, "shifted");
      assert.match(changing.stop.recommendation, /追加回数/);
      assert.match(changing.stop.recommendation, /ヒント/);
      assert.match(changing.stop.recommendation, /再プラン/);
      assert.doesNotThrow(() =>
        assert.ok(["extraRounds", "hint", "replanRemaining"].every((name) =>
          changing.stop.recommendation.includes(name === "extraRounds" ? "追加回数" : name === "hint" ? "ヒント" : "再プラン"),
        )),
      );
    }
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("変化したチェック失敗でも要求を満たしていれば懸念を持って進む", async () => {
  const repo = await initRepo();
  try {
    const changingCheck =
      "sh -c 'i=0; [ -f .check-n ] && i=$(cat .check-n); i=$((i+1)); echo $i > .check-n; echo fail-$i; exit 1'";
    const result = await runWorkflow({
      repo,
      ticketPath: await writeTicket(),
      config: { ...config, review: { maxLoops: 2 }, checks: [changingCheck] },
      steps: steps({
        clarify: async () => ({ decision: "proceed", assumptions: [] }),
        plan: async () => ({
          assumptions: [],
          tasks: [{ id: "feature", title: "機能", dependsOn: [], instructions: "機能" }],
        }),
        implement: async () => {},
        review: async () => ({ decision: "pass", concerns: ["フレークしうる"] }),
      }),
    });
    assert.equal(result.status, "ready");
    if (result.status === "ready") {
      assert.ok(result.concerns.includes("フレークしうる"));
    }
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("衝突の再開は未解消なら再停止し、解消済みなら取り込み以降をやり直さない", async () => {
  const repo = await initRepo();
  try {
    const first = await runWorkflow({
      repo,
      ticketPath: await writeTicket(),
      config,
      steps: steps({
        clarify: async () => ({ decision: "proceed", assumptions: ["衝突しても残す"] }),
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
    if (first.status !== "escalated") throw new Error("expected stop");
    const blocked = await runWorkflow({
      repo,
      ticketPath: await writeTicket(),
      config,
      steps: steps({
        implement: async () => {
          throw new Error("未解消の再開で実装し直さない");
        },
        review: async () => {
          throw new Error("未解消なら検品しない");
        },
      }),
      resume: { state: await loadLoopState(first.runDir), continueFromIngest: true },
    });
    assert.equal(blocked.status, "escalated");
    if (blocked.status !== "escalated") throw new Error("expected stop");
    assert.equal(blocked.stop.kind, "conflict");
    assert.deepEqual(blocked.stop.conflicts, ["shared.txt"]);
    assert.equal(blocked.integrationPath, first.integrationPath);
    assert.equal(blocked.stop.branch, first.stop.branch);
    assert.equal(blocked.runId, first.runId);

    await writeFile(path.join(first.integrationPath!, "shared.txt"), "resolved\n");
    await git(first.integrationPath!, ["add", "shared.txt"]);
    const implemented: string[] = [];
    const resumed = await runWorkflow({
      repo,
      ticketPath: await writeTicket(),
      config,
      steps: steps({
        implement: async ({ task }) => {
          implemented.push(task.id);
          throw new Error(`完了済みまたは未取り込み成果を実装し直した: ${task.id}`);
        },
        review: async ({ plan }) => {
          assert.ok("assumptions" in plan && plan.assumptions.includes("衝突しても残す"));
          return { decision: "pass", concerns: [] };
        },
      }),
      resume: { state: await loadLoopState(first.runDir), continueFromIngest: true },
    });
    assert.equal(resumed.status, "ready");
    assert.deepEqual(implemented, []);
    assert.equal(resumed.integrationPath, first.integrationPath);
    assert.equal(resumed.runId, first.runId);
    assert.equal(await readFile(path.join(resumed.integrationPath!, "shared.txt"), "utf8"), "resolved\n");
    const branches = await git(repo, ["branch"]);
    assert.equal([...branches.matchAll(/integration/g)].length, 1);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("統合作業ツリーの逸脱は再開時に変更せず止まり、元ブランチへ戻したあとだけ続く", async () => {
  const repo = await initRepo();
  const issue = (id: string) => ({ id, title: id, dependsOn: [] as string[], instructions: id });
  try {
    let reviews = 0;
    const implemented: string[] = [];
    const first = await runWorkflow({
      repo,
      ticketPath: await writeTicket(),
      config: { ...config, review: { maxLoops: 2 } },
      steps: steps({
        clarify: async () => ({ decision: "proceed", assumptions: [] }),
        plan: async () => ({
          assumptions: [],
          tasks: [{ id: "feature", title: "機能", dependsOn: [], instructions: "機能" }],
        }),
        implement: async ({ task }) => {
          implemented.push(task.id);
        },
        review: async () => {
          reviews += 1;
          if (reviews === 1) {
            return { decision: "fix", issues: [issue("fix-a"), issue("fix-b")] };
          }
          return { decision: "fix", issues: [issue("fix-a")] };
        },
      }),
    });
    assert.equal(first.status, "escalated");
    if (first.status !== "escalated") throw new Error("expected stop");
    assert.equal(first.stop.kind, "decreasing-fatal");
    const integrationPath = first.integrationPath!;
    const expectedBranch = first.stop.branch;
    const beforeHead = await git(integrationPath, ["rev-parse", "HEAD"]);
    await git(integrationPath, ["checkout", "-B", "stray"]);
    const implementedBefore = [...implemented];

    const stillDrifted = await runWorkflow({
      repo,
      ticketPath: await writeTicket(),
      config: { ...config, review: { maxLoops: 2 } },
      steps: steps({
        clarify: async () => {
          throw new Error("逸脱中は要件確認しない");
        },
        plan: async () => {
          throw new Error("逸脱中は再プランしない");
        },
        implement: async () => {
          throw new Error("逸脱中は実装しない");
        },
        review: async () => {
          throw new Error("逸脱中は検品しない");
        },
      }),
      resume: { state: first.resumeState, extraRounds: 1 },
    });
    assert.equal(stillDrifted.status, "escalated");
    if (stillDrifted.status === "escalated") {
      assert.equal(stillDrifted.stop.kind, "branch-deviation");
      assert.match(stillDrifted.stop.lastOutput, /外れました/);
      assert.equal(stillDrifted.integrationPath, first.integrationPath);
      assert.equal(stillDrifted.stop.branch, expectedBranch);
    }
    assert.equal(await git(integrationPath, ["rev-parse", "--abbrev-ref", "HEAD"]), "stray");
    assert.equal(await git(integrationPath, ["rev-parse", "HEAD"]), beforeHead);
    assert.deepEqual(implemented, implementedBefore);

    await git(integrationPath, ["checkout", expectedBranch]);
    const restored = await runWorkflow({
      repo,
      ticketPath: await writeTicket(),
      config: { ...config, review: { maxLoops: 2 } },
      steps: steps({
        clarify: async () => {
          throw new Error("再開で要件確認しない");
        },
        plan: async () => {
          throw new Error("再開で最初からプランしない");
        },
        implement: async ({ task }) => {
          implemented.push(task.id);
        },
        review: async () => ({ decision: "pass", concerns: [] }),
      }),
      resume: { state: first.resumeState, extraRounds: 1 },
    });
    assert.equal(restored.status, "ready");
    assert.equal(restored.integrationPath, first.integrationPath);
    assert.equal(await git(integrationPath, ["rev-parse", "--abbrev-ref", "HEAD"]), expectedBranch);
    assert.deepEqual(implemented, [...implementedBefore, "fix-a"]);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("取り込み前に統合作業ツリーが逸脱しているとマージせず止まり、元ブランチへ戻したあとだけ続く", async () => {
  const repo = await initRepo();
  try {
    const first = await runWorkflow({
      repo,
      ticketPath: await writeTicket(),
      config,
      steps: steps({
        clarify: async () => ({ decision: "proceed", assumptions: [] }),
        plan: async () => ({
          assumptions: [],
          tasks: [{ id: "feature", title: "機能", dependsOn: [], instructions: "機能" }],
        }),
        implement: async ({ worktree }) => {
          await writeFile(path.join(worktree.path, "feature.txt"), "ok\n");
          await git(path.resolve(worktree.path, "..", "..", "integration"), ["checkout", "-B", "stray"]);
        },
        review: async () => {
          throw new Error("逸脱したら検品まで進まない");
        },
      }),
    });
    assert.equal(first.status, "escalated");
    if (first.status !== "escalated") throw new Error("expected stop");
    assert.equal(first.stop.kind, "branch-deviation");
    assert.match(first.stop.lastOutput, /外れました/);
    const integrationPath = first.integrationPath!;
    const expectedBranch = first.stop.branch;
    assert.equal(await git(integrationPath, ["rev-parse", "--abbrev-ref", "HEAD"]), "stray");
    await assert.rejects(readFile(path.join(integrationPath, "feature.txt"), "utf8"));

    const stillDrifted = await runWorkflow({
      repo,
      ticketPath: await writeTicket(),
      config,
      steps: steps({
        implement: async () => {
          throw new Error("逸脱の再開で実装し直さない");
        },
        review: async () => {
          throw new Error("未解消なら検品しない");
        },
      }),
      resume: { state: first.resumeState, continueFromIngest: true },
    });
    assert.equal(stillDrifted.status, "escalated");
    if (stillDrifted.status === "escalated") {
      assert.equal(stillDrifted.stop.kind, "branch-deviation");
    }
    assert.equal(await git(integrationPath, ["rev-parse", "--abbrev-ref", "HEAD"]), "stray");
    await assert.rejects(readFile(path.join(integrationPath, "feature.txt"), "utf8"));

    await git(integrationPath, ["checkout", expectedBranch]);
    const restored = await runWorkflow({
      repo,
      ticketPath: await writeTicket(),
      config,
      steps: steps({
        implement: async () => {
          throw new Error("戻したあとも実装し直さない");
        },
        review: async () => ({ decision: "pass", concerns: [] }),
      }),
      resume: { state: await loadLoopState(first.runDir), continueFromIngest: true },
    });
    assert.equal(restored.status, "ready");
    assert.equal(restored.integrationPath, first.integrationPath);
    assert.equal(await git(integrationPath, ["rev-parse", "--abbrev-ref", "HEAD"]), expectedBranch);
    assert.equal(await readFile(path.join(integrationPath, "feature.txt"), "utf8"), "ok\n");
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("ブランチ逸脱の再開は戻してから取り込み、環境失敗はチェック種別を優先する", async () => {
  const repo = await initRepo();
  try {
    const drifted = await runWorkflow({
      repo,
      ticketPath: await writeTicket(),
      config,
      steps: steps({
        clarify: async () => ({ decision: "proceed", assumptions: [] }),
        plan: async () => ({
          assumptions: [],
          tasks: [{ id: "feature", title: "機能", dependsOn: [], instructions: "機能" }],
        }),
        implement: async ({ worktree }) => {
          await writeFile(path.join(worktree.path, "feature.txt"), "ok\n");
          await execFileAsync("git", ["checkout", "-b", "drift"], { cwd: worktree.path });
        },
        review: async () => {
          throw new Error("逸脱したら検品まで進まない");
        },
      }),
    });
    if (drifted.status !== "escalated") throw new Error("expected stop");
    const stillDrifted = await runWorkflow({
      repo,
      ticketPath: await writeTicket(),
      config,
      steps: steps({
        implement: async () => {
          throw new Error("逸脱の再開で実装し直さない");
        },
        review: async () => {
          throw new Error("未解消なら検品しない");
        },
      }),
      resume: { state: drifted.resumeState, continueFromIngest: true },
    });
    assert.equal(stillDrifted.status, "escalated");
    if (stillDrifted.status === "escalated") {
      assert.equal(stillDrifted.stop.kind, "branch-deviation");
      assert.equal(stillDrifted.integrationPath, drifted.integrationPath);
    }
    await git(path.join(drifted.runDir, "tasks", "feature"), ["checkout", `harness/${drifted.runId}/task/feature`]);
    const restored = await runWorkflow({
      repo,
      ticketPath: await writeTicket(),
      config,
      steps: steps({
        implement: async () => {
          throw new Error("戻したあとも実装し直さない");
        },
        review: async () => ({ decision: "pass", concerns: [] }),
      }),
      resume: { state: await loadLoopState(drifted.runDir), continueFromIngest: true },
    });
    assert.equal(restored.status, "ready");
    assert.equal(restored.integrationPath, drifted.integrationPath);
    assert.equal(await readFile(path.join(restored.integrationPath!, "feature.txt"), "utf8"), "ok\n");

    const implemented: string[] = [];
    const env = await runWorkflow({
      repo,
      ticketPath: await writeTicket(),
      config: {
        ...config,
        review: { maxLoops: 3 },
        checks: ["printf '%s\\n' 'TAP version 13' 'not ok 1 unauthorized response' 'AssertionError: expected unauthorized'; exit 1"],
      },
      steps: steps({
        clarify: async () => ({ decision: "proceed", assumptions: [] }),
        plan: async () => ({
          assumptions: [],
          tasks: [{ id: "feature", title: "機能", dependsOn: [], instructions: "機能" }],
        }),
        implement: async ({ task }) => {
          implemented.push(task.id);
        },
        review: async () => {
          throw new Error("テスト不合格を環境失敗にしない");
        },
      }),
    });
    assert.equal(env.status, "escalated");
    if (env.status === "escalated") {
      assert.equal(env.stop.kind, "stalled");
      assert.notEqual(env.stop.kind, "environment-check");
    }
    assert.equal(implemented.filter((id) => id.startsWith("checks-")).length, 1);
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
