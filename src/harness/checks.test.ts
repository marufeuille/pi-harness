import assert from "node:assert/strict";
import { access, chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  classifyCheckFailure,
  isEnvironmentFailure,
  runChecks,
} from "./checks.ts";

test("すべてのコマンドが成功したら ok だけを返す", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "checks-ok-"));
  try {
    const result = await runChecks(cwd, ["true", "printf ok"]);
    assert.deepEqual(result, { ok: true });
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("チェック不合格は失敗コマンド・終了情報・出力を残し、環境失敗にはしない", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "checks-fail-"));
  try {
    const result = await runChecks(cwd, ["true", "printf 'test output\\n'; exit 7"]);
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.command, "printf 'test output\\n'; exit 7");
    assert.equal(result.exit.code, 7);
    assert.equal(result.exit.signal, null);
    assert.match(result.output, /test output/);
    assert.equal(result.kind, "check-failed");
    assert.equal(isEnvironmentFailure(result), false);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("存在しないコマンドは command-not-found として環境失敗になる", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "checks-missing-"));
  try {
    const result = await runChecks(cwd, ["definitely-not-a-harness-command-xyzabc"]);
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.command, "definitely-not-a-harness-command-xyzabc");
    assert.equal(result.exit.code, 127);
    assert.equal(result.kind, "command-not-found");
    assert.equal(isEnvironmentFailure(result), true);
    assert.match(result.output, /not found/i);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("実行権限のないコマンドは permission として環境失敗になる", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "checks-perm-"));
  try {
    const script = path.join(cwd, "noexec.sh");
    await writeFile(script, "#!/bin/sh\necho should-not-run\n");
    await chmod(script, 0o644);
    const result = await runChecks(cwd, ["./noexec.sh"]);
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.command, "./noexec.sh");
    assert.equal(result.kind, "permission");
    assert.equal(isEnvironmentFailure(result), true);
    assert.equal(result.exit.code, 126);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("認証失敗の出力は authentication として環境失敗になる", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "checks-auth-"));
  try {
    const result = await runChecks(cwd, [
      "printf '%s\\n' \"fatal: Authentication failed for 'https://example.com/repo.git'\" >&2; exit 1",
    ]);
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.kind, "authentication");
    assert.equal(isEnvironmentFailure(result), true);
    assert.equal(result.exit.code, 1);
    assert.match(result.output, /Authentication failed/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("テストランナーの不合格文面に認証語があっても実装不備のままにする", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "checks-assert-"));
  try {
    const result = await runChecks(cwd, [
      "printf '%s\\n' 'TAP version 13' 'not ok 1 unauthorized response' 'AssertionError: expected unauthorized'; exit 1",
    ]);
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.kind, "check-failed");
    assert.equal(isEnvironmentFailure(result), false);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("失敗したコマンドのあとにあるコマンドは実行しない", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "checks-stop-"));
  try {
    const marker = path.join(cwd, "should-not-exist");
    const result = await runChecks(cwd, ["false", `touch '${marker}'`]);
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.command, "false");
    assert.equal(result.kind, "check-failed");
    await assert.rejects(() => access(marker));
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("classifyCheckFailure は終了コードと出力から種別を決める", () => {
  assert.equal(classifyCheckFailure({ code: 127, signal: null }, "sh: missing: not found"), "command-not-found");
  assert.equal(classifyCheckFailure({ code: 126, signal: null }, "sh: ./x: Permission denied"), "permission");
  assert.equal(
    classifyCheckFailure({ code: 1, signal: null }, "please log in with gh auth login"),
    "authentication",
  );
  assert.equal(classifyCheckFailure({ code: 1, signal: null }, "expected 3 to equal 4"), "check-failed");
});
