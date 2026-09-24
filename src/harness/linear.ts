import type { Ticket } from "./contract.ts";

const API_URL = "https://api.linear.app/graphql";

export type LinearFailureReason = "authentication" | "permission" | "communication" | "api" | "not_found" | "empty_body" | "invalid_input";
export type LinearIssueResult =
  | { ok: true; ticket: Ticket }
  | { ok: false; reason: LinearFailureReason };

type LinearIssue = { identifier?: unknown; title?: unknown; description?: unknown };
type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

/** Fetches one Linear issue. Credentials are only ever sent to the fixed Linear API endpoint. */
export async function loadLinearIssue(
  input: string,
  options: { apiKey?: string; fetch?: FetchLike } = {},
): Promise<LinearIssueResult> {
  const issueId = parseIssueId(input);
  if (!issueId) return { ok: false, reason: "invalid_input" };

  const apiKey = options.apiKey ?? process.env.LINEAR_API_KEY;
  if (!apiKey) return { ok: false, reason: "authentication" };

  let response: Response;
  try {
    response = await (options.fetch ?? fetch)(API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: apiKey },
      body: JSON.stringify({
        query: "query Issue($id: String!) { issue(id: $id) { identifier title description } }",
        variables: { id: issueId },
      }),
    });
  } catch {
    return { ok: false, reason: "communication" };
  }

  if (response.status === 401) return { ok: false, reason: "authentication" };
  if (response.status === 403) return { ok: false, reason: "permission" };
  if (!response.ok) return { ok: false, reason: "api" };

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    return { ok: false, reason: "api" };
  }
  if (!isRecord(payload)) return { ok: false, reason: "api" };
  if (Array.isArray(payload.errors) && payload.errors.length > 0) {
    const messages = payload.errors.map((error) => isRecord(error) && typeof error.message === "string" ? error.message.toLowerCase() : "").join(" ");
    if (/unauthori[sz]ed|authentication|invalid token/.test(messages)) return { ok: false, reason: "authentication" };
    if (/forbidden|permission|not authorized/.test(messages)) return { ok: false, reason: "permission" };
    return { ok: false, reason: "api" };
  }
  const data = payload.data;
  const issue = isRecord(data) ? data.issue : undefined;
  if (issue === null) return { ok: false, reason: "not_found" };
  if (!isRecord(issue) || typeof issue.title !== "string" || typeof issue.description !== "string") {
    return { ok: false, reason: "api" };
  }
  if (!issue.description.trim()) return { ok: false, reason: "empty_body" };
  return {
    ok: true,
    ticket: {
      path: `linear:${typeof issue.identifier === "string" ? issue.identifier : issueId}`,
      title: issue.title,
      body: issue.description,
    },
  };
}

function parseIssueId(input: string): string | undefined {
  const value = input.trim();
  if (!value) return undefined;
  if (!/^https?:\/\//i.test(value)) return value;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || !["linear.app", "www.linear.app"].includes(url.hostname)) return undefined;
    const match = url.pathname.match(/^\/[^/]+\/issue\/([^/]+)(?:\/|$)/);
    return match?.[1] ? decodeURIComponent(match[1]) : undefined;
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
