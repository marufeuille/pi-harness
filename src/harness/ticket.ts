import { readFile } from "node:fs/promises";
import path from "node:path";

import type { Ticket } from "./contract.ts";

export async function loadTicket(ticketPath: string): Promise<Ticket> {
  const body = await readFile(ticketPath, "utf8");
  const heading = body.match(/^#\s+(.+)$/m);
  const title = heading?.[1]?.trim() || path.basename(ticketPath);
  return { path: ticketPath, title, body };
}

export async function loadLinearTicket(identifier: string): Promise<Ticket> {
  // The Linear adapter owns authentication and retrieval; credentials are never persisted here.
  const modulePath = "./linear.ts";
  const adapter = await import(modulePath) as {
    getIssue?: (id: string) => Promise<{ title: string; body: string }>;
    fetchIssue?: (id: string) => Promise<{ title: string; body: string }>;
  };
  const retrieve = adapter.getIssue ?? adapter.fetchIssue;
  if (!retrieve) throw new Error("Linear 取得 API が利用できません");
  const issue = await retrieve(identifier);
  if (!issue || typeof issue.title !== "string" || typeof issue.body !== "string") {
    throw new Error("Linear の課題を取得できませんでした");
  }
  if (!issue.body.trim()) throw new Error("Linear の課題本文が空です");
  return { path: `linear:${identifier}`, title: issue.title, body: issue.body };
}
