import { copyFile, mkdir, readdir } from "node:fs/promises";
import path from "node:path";

export async function profilerLogFiles(cwd: string): Promise<Set<string>> {
  const source = path.join(cwd, ".pi-observability");
  const names = await readdir(source).catch(() => []);
  return new Set(names.filter((name) => name.endsWith(".jsonl")));
}

export async function archiveProfilerLogs(cwd: string, destination: string, before: ReadonlySet<string>): Promise<void> {
  const source = path.join(cwd, ".pi-observability");
  const names = await profilerLogFiles(cwd);
  for (const name of names) {
    if (before.has(name)) continue;
    await mkdir(destination, { recursive: true });
    await copyFile(path.join(source, name), path.join(destination, name));
  }
}
