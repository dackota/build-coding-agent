// The implement loop's calls to the GitHub MCP server, made from code: reading the issue, then
// the branch, the push and the pull request. They bypass requireApproval on purpose: the start
// approval named the repo and the branch, and that is the consent. The model's own MCP tools
// (mcp-tools.ts) keep their gate. No call here is bound for the model.
import type { Tool } from "ai";
import type { McpBinding } from "./config.ts";
import { openMcpTools } from "./mcp-tools.ts";
import type { Issue, Target } from "./loop.ts";

const PR_TOOL = "create_pull_request";
const PR_URL = /https:\/\/github\.com\/[^\s"\\]+\/pull\/\d+/;

export type Github = {
  readIssue(target: Target): Promise<Issue>;
  createBranch(target: Target, branch: string, from: string): Promise<void>;
  pushFiles(target: Target, branch: string, files: { path: string; content: string }[], message: string): Promise<void>;
  createPullRequest(target: Target, args: { title: string; body: string; head: string; base: string }): Promise<string>;
  close(): Promise<void>;
};

let callCount = 0;

/** The binding that serves the pull request tools: the GitHub MCP server. */
export function githubBinding(bindings: readonly McpBinding[]): McpBinding | undefined {
  return bindings.find((b) => b.tools.includes(PR_TOOL));
}

function asJson(text: string, what: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`the GitHub MCP server's ${what} reply is not JSON`);
  }
}

const textOf = (value: unknown): string => (typeof value === "string" ? value : "");

/** An issue from the server's `get` and `get_comments` replies. */
export function parseIssue(issueJson: string, commentsJson: string): Issue {
  const issue = asJson(issueJson, "issue") as { title?: unknown; body?: unknown };
  if (typeof issue?.title !== "string") throw new Error("the GitHub MCP server's issue reply has no title");
  const parsed = asJson(commentsJson, "comments") as unknown;
  const list = Array.isArray(parsed) ? parsed : ((parsed as { comments?: unknown })?.comments ?? []);
  const comments = Array.isArray(list) ? list.map((c) => textOf((c as { body?: unknown })?.body)).filter((b) => b !== "") : [];
  return { title: issue.title, body: textOf(issue.body), comments };
}

/** The pull request's URL in the server's reply: its `url` or `html_url`, else a pull request link in the text. */
export function parsePullRequestUrl(reply: string): string | undefined {
  try {
    const json = JSON.parse(reply) as { html_url?: unknown; url?: unknown };
    for (const candidate of [json?.html_url, json?.url]) if (typeof candidate === "string" && PR_URL.test(candidate)) return PR_URL.exec(candidate)![0];
  } catch {
    // not JSON: look in the text
  }
  return PR_URL.exec(reply)?.[0];
}

/** Opens the GitHub MCP server for the loop; close() closes it. Throws when no binding serves it, or the server is down. */
export async function openGithub(bindings: readonly McpBinding[]): Promise<Github> {
  const binding = githubBinding(bindings);
  if (!binding) throw new Error("no GitHub MCP binding in the agent config (a binding with create_pull_request)");
  // Every tool of the server, ungated: the loop picks the fixed calls itself.
  const mcp = await openMcpTools([{ ...binding, tools: [], requireApproval: false }], { allows: () => true });
  const call = async (name: string, args: Record<string, unknown>): Promise<string> => {
    const tool: Tool | undefined = mcp.tools[name];
    if (!tool?.execute) throw new Error(`the GitHub MCP server has no tool ${name}`);
    const out = await tool.execute(args as never, { toolCallId: `loop-${++callCount}`, messages: [] });
    return typeof out === "string" ? out : JSON.stringify(out);
  };
  const repo = (t: Target) => ({ owner: t.owner, repo: t.repo });
  return {
    async readIssue(target) {
      const base = { ...repo(target), issue_number: target.number };
      const issue = await call("issue_read", { ...base, method: "get" });
      const comments = await call("issue_read", { ...base, method: "get_comments" });
      return parseIssue(issue, comments);
    },
    async createBranch(target, branch, from) {
      await call("create_branch", { ...repo(target), branch, from_branch: from });
    },
    async pushFiles(target, branch, files, message) {
      await call("push_files", { ...repo(target), branch, files, message });
    },
    async createPullRequest(target, args) {
      const reply = await call(PR_TOOL, { ...repo(target), ...args });
      const url = parsePullRequestUrl(reply);
      if (!url) throw new Error("the GitHub MCP server's pull request reply has no pull request URL");
      return url;
    },
    close: mcp.close,
  };
}
