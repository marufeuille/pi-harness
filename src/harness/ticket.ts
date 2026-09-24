import { readFile } from "node:fs/promises";
import path from "node:path";

import type { Ticket } from "./contract.ts";
import { loadLinearIssue } from "./linear.ts";

export async function loadTicket(ticketPath: string): Promise<Ticket> {
  const body = await readFile(ticketPath, "utf8");
  const heading = body.match(/^#\s+(.+)$/m);
  const title = heading?.[1]?.trim() || path.basename(ticketPath);
  return { path: ticketPath, title, body };
}

export async function loadLinearTicket(identifier: string): Promise<Ticket> {
  const result = await loadLinearIssue(identifier);
  if (!result.ok) {
    const reasons = {
      authentication: "認証に失敗しました",
      permission: "課題へのアクセスが許可されていません",
      communication: "Linear に接続できませんでした",
      api: "Linear API で取得に失敗しました",
      not_found: "課題が見つかりません",
      empty_body: "課題本文が空です",
      invalid_input: "課題 ID または URL が不正です",
    };
    throw new Error(`Linear の課題を取得できませんでした: ${reasons[result.reason]}`);
  }
  return result.ticket;
}
