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

/** Updates only the workflow state of an existing issue. */
export async function updateLinearIssueState(
  input: string,
  stateName: "In Progress" | "Done",
  options: { apiKey?: string; fetch?: FetchLike } = {},
): Promise<void> {
  const issueId = parseIssueId(input);
  if (!issueId) throw new Error("Linear state update failed: invalid_input");
  const apiKey = options.apiKey ?? process.env.LINEAR_API_KEY;
  if (!apiKey) throw new Error("Linear state update failed: authentication");
  const request = async (query: string, variables: Record<string, string>): Promise<unknown> => {
    let response: Response;
    try {
      response = await (options.fetch ?? fetch)(API_URL, {
        method: "POST", headers: { "Content-Type": "application/json", Authorization: apiKey },
        body: JSON.stringify({ query, variables }),
      });
    } catch { throw new Error("Linear state update failed: communication"); }
    if (response.status === 401) throw new Error("Linear state update failed: authentication");
    if (response.status === 403) throw new Error("Linear state update failed: permission");
    if (!response.ok) throw new Error("Linear state update failed: api");
    let payload: unknown;
    try { payload = await response.json(); } catch { throw new Error("Linear state update failed: api"); }
    if (!isRecord(payload)) throw new Error("Linear state update failed: api");
    if (Array.isArray(payload.errors) && payload.errors.length) {
      const messages = payload.errors.map((e) => isRecord(e) && typeof e.message === "string" ? e.message.toLowerCase() : "").join(" ");
      const reason = /unauthori[sz]ed|authentication|invalid token/.test(messages) ? "authentication" : /forbidden|permission|not authorized/.test(messages) ? "permission" : "api";
      throw new Error(`Linear state update failed: ${reason}`);
    }
    return payload.data;
  };
  const data = await request("query IssueState($id: String!) { issue(id: $id) { id team { id states: workflowStates { nodes { id name } } } } }", { id: issueId });
  const issue = isRecord(data) ? data.issue : undefined;
  if (!issue) throw new Error("Linear state update failed: not_found");
  if (!isRecord(issue) || typeof issue.id !== "string" || !isRecord(issue.team) || !Array.isArray(issue.team.states?.nodes)) throw new Error("Linear state update failed: api");
  const matches = (issue.team.states.nodes as unknown[]).filter((s) => isRecord(s) && s.name === stateName && typeof s.id === "string");
  if (matches.length !== 1) throw new Error(`Linear state update failed: ${matches.length ? "ambiguous_state" : "state_not_found"}`);
  const stateId = (matches[0] as Record<string, unknown>).id as string;
  const updated = await request("mutation UpdateIssueState($id: String!, $stateId: String!) { issueUpdate(id: $id, input: { stateId: $stateId }) { success } }", { id: issue.id, stateId });
  const result = isRecord(updated) ? updated.issueUpdate : undefined;
  if (!isRecord(result) || result.success !== true) throw new Error("Linear state update failed: update_failed");
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
