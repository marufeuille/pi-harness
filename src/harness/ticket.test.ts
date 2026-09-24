import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { loadTicket } from "./ticket.ts";

test("Markdown ticket keeps its heading title and body", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "ticket-"));
  try {
    const file = path.join(dir, "ticket.md");
    await writeFile(file, "# Regression title\n\nBody text\n");
    assert.deepEqual(await loadTicket(file), { path: file, title: "Regression title", body: "# Regression title\n\nBody text\n" });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
