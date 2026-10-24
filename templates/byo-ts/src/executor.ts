import { randomUUID } from "node:crypto";
import { Role, TaskState } from "@a2a-js/sdk";
import type { Message, Task } from "@a2a-js/sdk";
import { AgentEvent, type AgentExecutor, type ExecutionEventBus, type RequestContext } from "@a2a-js/sdk/server";
import { type ModelMessage, streamText } from "ai";
import type { StarterConfig } from "./config.ts";
import { log } from "./log.ts";
import { gatewayModel } from "./model.ts";

const textPart = (value: string) => ({ content: { $case: "text" as const, value }, metadata: undefined, filename: "", mediaType: "text/plain" });
const status = (state: TaskState, message?: Message) => ({ state, message, timestamp: new Date().toISOString() });

function agentText(contextId: string, taskId: string, text: string): Message {
  return { messageId: randomUUID(), contextId, taskId, role: Role.ROLE_AGENT, parts: [textPart(text)], metadata: undefined, extensions: [], referenceTaskIds: [] };
}

function userText(message: Message): string {
  return message.parts.map((p) => (p.content?.$case === "text" ? p.content.value : "")).join("\n");
}

/**
 * One turn is one task: WORKING, then the model's reply as an artifact, then COMPLETED (or
 * FAILED with the reason). Each of these events is a task save at the controller, and the
 * task store settles only the last (docs/byo-contract.md, "settle only at real boundaries").
 *
 * Kept short on purpose. The starter has no tools, subagents, or pauses; where to add them
 * is in the contract doc, and agent/src in this repo is a worked example of each.
 * The conversation is held in memory; keep it on /data to survive an actor suspend.
 */
export function createExecutor(config: StarterConfig, env: NodeJS.ProcessEnv): AgentExecutor {
  const model = gatewayModel(config.baseUrl, config.model, env);
  const conversations = new Map<string, ModelMessage[]>();

  return {
    async execute(ctx: RequestContext, bus: ExecutionEventBus): Promise<void> {
      const { taskId, contextId } = ctx;
      const publish = (state: TaskState, message?: Message) =>
        bus.publish(AgentEvent.statusUpdate({ taskId, contextId, status: status(state, message), metadata: undefined }));
      bus.publish(
        AgentEvent.task({
          ...(ctx.task ?? { id: taskId, contextId, artifacts: [], history: [ctx.userMessage], metadata: undefined }),
          status: status(TaskState.TASK_STATE_WORKING),
        } as Task),
      );
      try {
        const messages: ModelMessage[] = [...(conversations.get(contextId) ?? []), { role: "user", content: userText(ctx.userMessage) }];
        const result = streamText({ model, system: config.instruction, messages });
        const reply = await result.text;
        conversations.set(contextId, [...messages, { role: "assistant", content: reply }]);
        bus.publish(
          AgentEvent.artifactUpdate({
            taskId,
            contextId,
            artifact: { artifactId: randomUUID(), name: "reply", description: "", parts: [textPart(reply)], metadata: undefined, extensions: [] },
            append: false,
            lastChunk: true,
            metadata: undefined,
          }),
        );
        publish(TaskState.TASK_STATE_COMPLETED);
      } catch (err) {
        log("turn-failed", { message: (err as Error).message });
        publish(TaskState.TASK_STATE_FAILED, agentText(contextId, taskId, `failed: ${(err as Error).message}`));
      }
      bus.finished();
    },

    async cancelTask(taskId: string, bus: ExecutionEventBus): Promise<void> {
      bus.publish(AgentEvent.statusUpdate({ taskId, contextId: "", status: status(TaskState.TASK_STATE_CANCELED), metadata: undefined }));
      bus.finished();
    },
  };
}
