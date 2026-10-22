import { Role } from "@a2a-js/sdk";
import { grpcClient } from "./helpers.ts";

export const HITL_URI = "https://kagent.dev/extensions/hitl/v1";

export type AskUserRequest = { type: "ask_user_request"; id: string; questions: { question: string; choices: string[]; multiple: boolean }[] };
export type Turn = {
  kind: "message" | "task";
  state: number;
  taskId: string;
  contextId: string;
  text: string;
  request?: AskUserRequest;
};

/** One SendMessage over A2A gRPC, as a kagent HITL client sends it. */
export async function sendTurn(
  port: number,
  opts: { text: string; taskId?: string; contextId?: string; answer?: { id: string; answers: string[][] } },
): Promise<Turn> {
  const client = await grpcClient(port);
  const result: any = await client.sendMessage({
    tenant: "",
    message: {
      messageId: crypto.randomUUID(),
      contextId: opts.contextId ?? "",
      taskId: opts.taskId ?? "",
      role: Role.ROLE_USER,
      parts: [{ content: { $case: "text", value: opts.text }, metadata: undefined, filename: "", mediaType: "" }],
      metadata: opts.answer
        ? { [HITL_URI]: { type: "ask_user_response", id: opts.answer.id, answers: opts.answer.answers.map((answer) => ({ answer })) } }
        : undefined,
      extensions: opts.answer ? [HITL_URI] : [],
      referenceTaskIds: [],
    },
    configuration: undefined,
    metadata: undefined,
  });
  const textOf = (parts: any[] = []) => parts.map((p) => (p.content?.$case === "text" ? p.content.value : "")).join("");
  if (!("status" in result)) return { kind: "message", state: 0, taskId: "", contextId: result.contextId, text: textOf(result.parts) };
  const message = result.status?.message;
  const payload = message?.metadata?.[HITL_URI];
  return {
    kind: "task",
    state: Number(result.status?.state),
    taskId: result.id,
    contextId: result.contextId,
    text: textOf(result.artifacts?.flatMap((a: any) => a.parts)) || textOf(message?.parts),
    request: payload?.type === "ask_user_request" ? payload : undefined,
  };
}
