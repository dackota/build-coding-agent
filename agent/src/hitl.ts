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

/** The ask_user_response in a user message, or undefined when the message carries none. */
export function parseAskUserResponse(message: Message): AskUserResponse | undefined {
  if (!message.extensions.includes(HITL_EXTENSION_URI)) return undefined;
  const payload = message.metadata?.[HITL_EXTENSION_URI] as { type?: unknown; id?: unknown; answers?: unknown } | undefined;
  if (payload?.type !== "ask_user_response" || typeof payload.id !== "string" || !Array.isArray(payload.answers)) return undefined;
  const answers = payload.answers.map((a) => ((a as { answer?: unknown }).answer ?? []) as unknown[]);
  if (!answers.every((a) => Array.isArray(a) && a.every((x) => typeof x === "string"))) return undefined;
  return { id: payload.id, answers: answers as string[][] };
}
