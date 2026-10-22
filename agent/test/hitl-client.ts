import { Role } from "@a2a-js/sdk";
import { grpcClient } from "./helpers.ts";

export const HITL_URI = "https://kagent.dev/extensions/hitl/v1";

export type AskUserRequest = { type: "ask_user_request"; id: string; questions: { question: string; choices: string[]; multiple: boolean }[] };
export type ToolApprovalRequest = {
  type: "tool_approval_request";
  hint: string;
  tools: { id: string; call_id: string; name: string; args: Record<string, unknown> }[];
};
/** One decision on the wire: kagent's ToolApproval, plus our optional scope for "approve for this session". */
export type WireApproval = { id: string; approved: boolean; rejection_reason?: string; scope?: "session" };
export type Turn = {
  kind: "message" | "task";
  state: number;
  taskId: string;
  contextId: string;
  text: string;
  request?: AskUserRequest;
  approvalRequest?: ToolApprovalRequest;
};

/** One SendMessage over A2A gRPC, as a kagent HITL client sends it. */
export async function sendTurn(
  port: number,
  opts: { text: string; taskId?: string; contextId?: string; answer?: { id: string; answers: string[][] }; approvals?: WireApproval[] },
): Promise<Turn> {
  const client = await grpcClient(port);
  const payload = opts.answer
    ? { type: "ask_user_response", id: opts.answer.id, answers: opts.answer.answers.map((answer) => ({ answer })) }
    : opts.approvals
      ? { type: "tool_approval_response", approvals: opts.approvals }
      : undefined;
  const result: any = await client.sendMessage({
    tenant: "",
    message: {
      messageId: crypto.randomUUID(),
      contextId: opts.contextId ?? "",
      taskId: opts.taskId ?? "",
      role: Role.ROLE_USER,
      parts: [{ content: { $case: "text", value: opts.text }, metadata: undefined, filename: "", mediaType: "" }],
      metadata: payload ? { [HITL_URI]: payload } : undefined,
      extensions: payload ? [HITL_URI] : [],
      referenceTaskIds: [],
    },
    configuration: undefined,
    metadata: undefined,
  });
  const textOf = (parts: any[] = []) => parts.map((p) => (p.content?.$case === "text" ? p.content.value : "")).join("");
  if (!("status" in result)) return { kind: "message", state: 0, taskId: "", contextId: result.contextId, text: textOf(result.parts) };
  const message = result.status?.message;
  const request = message?.metadata?.[HITL_URI];
  return {
    kind: "task",
    state: Number(result.status?.state),
    taskId: result.id,
    contextId: result.contextId,
    text: textOf(result.artifacts?.flatMap((a: any) => a.parts)) || textOf(message?.parts),
    request: request?.type === "ask_user_request" ? request : undefined,
    approvalRequest: request?.type === "tool_approval_request" ? request : undefined,
  };
}
