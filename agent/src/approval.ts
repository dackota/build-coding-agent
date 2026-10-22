// The tool approval pause: built from the AI SDK's approval requests (risky shell commands, and
// calls of tools on an MCP binding with requireApproval), and resumed from the user's decisions
// (approve, deny with a reason, approve for this session).
import type { ModelMessage } from "ai";
import type { ToolApprovalResponse } from "./hitl.ts";
import type { ToolApprovalPause } from "./session-state.ts";
import type { ApprovalGate } from "./shell-tool.ts";
import { mcpKind } from "./mcp-tools.ts";
import { riskKinds, SHELL_TOOL } from "./shell-tool.ts";

type ApprovalRequestPart = { type: "tool-approval-request"; approvalId: string; toolCall: { toolCallId: string; toolName: string; input: unknown } };

/** The gate for one turn: calls approved once, and risk kinds approved for the session. */
export function turnGate(approvedCalls: ReadonlySet<string>, sessionKinds: readonly string[]): ApprovalGate {
  return {
    allows: (toolCallId, kinds) => approvedCalls.has(toolCallId) || kinds.every((k) => sessionKinds.includes(k)),
    isDecided: (toolCallId) => approvedCalls.has(toolCallId),
  };
}

/** The approval requests in a turn's content, as the tools of a pause; empty when nothing waits. */
export function pendingTools(content: readonly { type: string }[]): ToolApprovalPause["tools"] {
  return content
    .filter((p): p is ApprovalRequestPart => p.type === "tool-approval-request")
    .map(({ approvalId, toolCall }) => {
      const args = (toolCall.input ?? {}) as Record<string, unknown>;
      const name = toolCall.toolName;
      const kinds = name === SHELL_TOOL ? riskKinds(String(args.command ?? "")) : [mcpKind(name)];
      return { id: approvalId, call_id: toolCall.toolCallId, name, args, kinds };
    });
}

export function approvalHint(tools: ToolApprovalPause["tools"]): string {
  const isShellOnly = tools.every((t) => t.name === SHELL_TOOL);
  if (tools.length === 1 && isShellOnly) return `Run ${JSON.stringify(String(tools[0]!.args.command ?? ""))} in the workspace?`;
  if (tools.length === 1) return `Call ${tools[0]!.name} with ${JSON.stringify(tools[0]!.args)}?`;
  return isShellOnly ? `Run ${tools.length} commands in the workspace?` : `Run ${tools.length} tool calls?`;
}

export type Resumed = { messages: ModelMessage[]; approvedCalls: Set<string>; sessionKinds: string[] };

/**
 * The conversation to resume with, or undefined when the response does not decide each pending
 * tool exactly once (then the task stays paused). A denial reaches the model as the tool's
 * result, with the user's reason.
 */
export function resumeApproval(pause: ToolApprovalPause, response: ToolApprovalResponse | undefined): Resumed | undefined {
  if (!response) return undefined;
  const ids = response.approvals.map((a) => a.id);
  const pendingIds = pause.tools.map((t) => t.id);
  if (new Set(ids).size !== ids.length || ids.length !== pendingIds.length || !ids.every((id) => pendingIds.includes(id))) return undefined;

  const approvedCalls = new Set<string>();
  const sessionKinds: string[] = [];
  const content = response.approvals.map(({ id, decision }) => {
    const tool = pause.tools.find((t) => t.id === id)!;
    if (decision.type !== "deny") approvedCalls.add(tool.call_id);
    if (decision.type === "approve_session") sessionKinds.push(...tool.kinds);
    const what = tool.name === SHELL_TOOL ? "command" : "tool call";
    const reason = decision.type === "deny" ? `The user denied this ${what}${decision.reason ? `: ${decision.reason}` : "."}` : undefined;
    return { type: "tool-approval-response" as const, approvalId: id, approved: decision.type !== "deny", reason };
  });
  return { messages: [...(pause.messages as ModelMessage[]), { role: "tool", content }], approvedCalls, sessionKinds };
}
