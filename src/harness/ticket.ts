import { readFile } from "node:fs/promises";
import path from "node:path";

import type { Ticket } from "./contract.ts";

export async function loadTicket(ticketPath: string): Promise<Ticket> {
  const body = await readFile(ticketPath, "utf8");
  const heading = body.match(/^#\s+(.+)$/m);
  const title = heading?.[1]?.trim() || path.basename(ticketPath);
  return { path: ticketPath, title, body };
}
