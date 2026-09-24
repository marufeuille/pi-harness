import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export async function runChecks(
  cwd: string,
  commands: string[],
): Promise<{ ok: true } | { ok: false; output: string }> {
  const chunks: string[] = [];

  for (const command of commands) {
    try {
      const { stdout, stderr } = await execFileAsync("sh", ["-c", command], {
        cwd,
        encoding: "utf8",
      });
      chunks.push(`$ ${command}\n${stdout}${stderr}`);
    } catch (error) {
      const failure = error as { stdout?: string; stderr?: string; message?: string };
      chunks.push(`$ ${command}\n${failure.stdout ?? ""}${failure.stderr ?? failure.message ?? ""}`);
      return { ok: false, output: chunks.join("\n").trim() };
    }
  }

  return { ok: true };
}
