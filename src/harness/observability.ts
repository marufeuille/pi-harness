import { copyFile, mkdir, readdir, stat } from "node:fs/promises";
import path from "node:path";

export async function archiveProfilerLogs(cwd: string, destination: string, since: number): Promise<void> {
  const source = path.join(cwd, ".pi-observability");
  const names = await readdir(source).catch(() => []);

  for (const name of names) {
    if (!name.endsWith(".jsonl")) {
      continue;
    }
    const filePath = path.join(source, name);
    const info = await stat(filePath);
    if (info.mtimeMs + 1000 < since) {
      continue;
    }
    await mkdir(destination, { recursive: true });
    await copyFile(filePath, path.join(destination, name));
  }
}
