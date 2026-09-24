import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { promisify } from "node:util";
import { execFile } from "node:child_process";

const exec = promisify(execFile);
const root = path.resolve(import.meta.dirname, "..");

test("harness e2e fixture contract is required for isolated acceptance runs", async () => {
  const fixture = process.env.HARNESS_E2E_FIXTURE;
  assert.ok(fixture, "HARNESS_E2E_FIXTURE must point to the fixed-response fixture");
  const temp = await mkdtemp(path.join(os.tmpdir(), "harness-e2e-"));
  try {
    const repo = path.join(temp, "repo");
    await import("node:fs/promises").then(({ mkdir, writeFile }) => mkdir(repo, { recursive: true }).then(() => writeFile(path.join(repo, "README.md"), "seed\n")));
    await exec("git", ["init", repo]);
    await exec("git", ["-C", repo, "-c", "user.name=E2E", "-c", "user.email=e2e@example.invalid", "add", "."]);
    await exec("git", ["-C", repo, "-c", "user.name=E2E", "-c", "user.email=e2e@example.invalid", "commit", "-m", "initial"]);
    const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
      const child = spawn("npm", ["run", "harness", "--", "--ticket", fixture, "--repo", repo], {
        cwd: root, env: { ...process.env, HARNESS_E2E_FIXTURE: fixture }, stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "", stderr = "";
      const timer = setTimeout(() => child.kill("SIGKILL"), 120_000);
      child.stdout.setEncoding("utf8").on("data", (chunk) => stdout += chunk);
      child.stderr.setEncoding("utf8").on("data", (chunk) => stderr += chunk);
      child.on("error", reject);
      child.on("close", (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
    });
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /"status":\s*"ready"/);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
