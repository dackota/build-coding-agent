// kagent's human-in-the-loop A2A extension (https://kagent.dev/extensions/hitl/v1).
// A pause is an input-required status whose message carries the request in
// metadata[URI] and lists the URI in `extensions`; the answer is a user message on the same
// task and context that does the same with an ask_user_response.
import { randomUUID } from "node:crypto";
import { Role } from "@a2a-js/sdk";
import type { Message } from "@a2a-js/sdk";

export const HITL_EXTENSION_URI = "https://kagent.dev/extensions/hitl/v1";

export type Question = { question: string; choices: string[]; multiple: boolean };
export type AskUserResponse = { id: string; answers: string[][] };

const textPart = (value: string) => ({
  content: { $case: "text" as const, value },
  metadata: undefined,
  filename: "",
  mediaType: "text/plain",
});

/** The agent message of an input-required status: a readable question plus the structured request. */
export function askUserMessage(args: { contextId: string; taskId: string; requestId: string; questions: Question[] }): Message {
  return {
    messageId: randomUUID(),
    contextId: args.contextId,
    taskId: args.taskId,
    role: Role.ROLE_AGENT,
    parts: [textPart(args.questions.map((q) => q.question).join("; "))],
    metadata: { [HITL_EXTENSION_URI]: { type: "ask_user_request", id: args.requestId, questions: args.questions } },
    extensions: [HITL_EXTENSION_URI],
    referenceTaskIds: [],
  };
}

/** One tool call awaiting a human decision, as kagent's HITLTool. */
export type HitlTool = { id: string; call_id: string; name: string; args: Record<string, unknown> };

/** A human decision on one tool call: more than yes or no. */
export type ApprovalDecision = { type: "approve" } | { type: "approve_session" } | { type: "deny"; reason: string };
export type ToolApprovalResponse = { approvals: { id: string; decision: ApprovalDecision }[] };

/**
 * The agent message of a tool approval pause. The text is the hint followed by the tool names
 * in parentheses, as every kagent runtime composes it.
 */
export function toolApprovalMessage(args: { contextId: string; taskId: string; hint: string; tools: HitlTool[] }): Message {
  const text = `${args.hint} (${[...new Set(args.tools.map((t) => t.name))].join(", ")})`;
  return {
    messageId: randomUUID(),
    contextId: args.contextId,
    taskId: args.taskId,
    role: Role.ROLE_AGENT,
    parts: [textPart(text)],
    metadata: { [HITL_EXTENSION_URI]: { type: "tool_approval_request", hint: text, tools: args.tools } },
    extensions: [HITL_EXTENSION_URI],
    referenceTaskIds: [],
  };
}

/**
 * The tool_approval_response in a user message, or undefined when it carries none or a malformed
 * one. kagent's ToolApproval is approved plus an optional rejection_reason; "approve for this
 * session" is approved with scope "session" (clients keep unknown fields).
 */
export function parseToolApprovalResponse(message: Message): ToolApprovalResponse | undefined {
  if (!message.extensions.includes(HITL_EXTENSION_URI)) return undefined;
  const payload = message.metadata?.[HITL_EXTENSION_URI] as { type?: unknown; approvals?: unknown } | undefined;
  if (payload?.type !== "tool_approval_response" || !Array.isArray(payload.approvals) || payload.approvals.length === 0) return undefined;
  const approvals: ToolApprovalResponse["approvals"] = [];
  for (const raw of payload.approvals as Record<string, unknown>[]) {
    if (typeof raw?.id !== "string" || raw.id === "" || typeof raw.approved !== "boolean") return undefined;
    const reason = typeof raw.rejection_reason === "string" ? raw.rejection_reason : "";
    const decision: ApprovalDecision = !raw.approved ? { type: "deny", reason } : raw.scope === "session" ? { type: "approve_session" } : { type: "approve" };
    approvals.push({ id: raw.id, decision });
  }
  return { approvals };
}

/** The ask_user_response in a user message, or undefined when the message carries none. */
export function parseAskUserResponse(message: Message): AskUserResponse | undefined {
  if (!message.extensions.includes(HITL_EXTENSION_URI)) return undefined;
  const payload = message.metadata?.[HITL_EXTENSION_URI] as { type?: unknown; id?: unknown; answers?: unknown } | undefined;
  if (payload?.type !== "ask_user_response" || typeof payload.id !== "string" || !Array.isArray(payload.answers)) return undefined;
  const answers = payload.answers.map((a) => ((a as { answer?: unknown }).answer ?? []) as unknown[]);
  if (!answers.every((a) => Array.isArray(a) && a.every((x) => typeof x === "string"))) return undefined;
  return { id: payload.id, answers: answers as string[][] };
}
