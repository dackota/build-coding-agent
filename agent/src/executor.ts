import { randomUUID } from "node:crypto";
import { Role } from "@a2a-js/sdk";
import { AgentEvent, type AgentExecutor, type ExecutionEventBus, type RequestContext } from "@a2a-js/sdk/server";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { generateText } from "ai";
import type { AgentConfig } from "./config.ts";
import { log } from "./log.ts";

const textPart = (value: string) => ({
  content: { $case: "text" as const, value },
  metadata: undefined,
  filename: "",
  mediaType: "text/plain",
});

function userText(ctx: RequestContext): string {
  return ctx.userMessage.parts.flatMap((p) => (p.content?.$case === "text" ? [p.content.value] : [])).join("\n");
}

/**
 * Answers each message with one model call through the gateway, as a Message (no Task).
 * kagent's controller keeps its own record of every Task and wants the agent to write it
 * through a task-store call that needs an actor identity this agent does not have yet, so
 * a Task reply makes the controller answer "task not found". A Message sidesteps it.
 */
export function createExecutor(config: AgentConfig): AgentExecutor {
  const model = createOpenAICompatible({ name: "gateway", baseURL: config.baseUrl }).chatModel(config.model);
  const reply = (contextId: string, text: string) =>
    AgentEvent.message({
      messageId: randomUUID(),
      contextId,
      taskId: "",
      role: Role.ROLE_AGENT,
      parts: [textPart(text)],
      metadata: undefined,
      extensions: [],
      referenceTaskIds: [],
    });

  return {
    async execute(ctx: RequestContext, bus: ExecutionEventBus): Promise<void> {
      try {
        const { text } = await generateText({ model, system: config.instruction || undefined, prompt: userText(ctx) });
        bus.publish(reply(ctx.contextId, text));
      } catch (err) {
        log("model-call-failed", { message: (err as Error).message });
        bus.publish(reply(ctx.contextId, `model call failed: ${(err as Error).message}`));
      }
      bus.finished();
    },

    async cancelTask(_taskId: string, bus: ExecutionEventBus): Promise<void> {
      bus.finished();
    },
  };
}
