import { randomUUID } from "node:crypto";
import { Role, TaskState } from "@a2a-js/sdk";
import type { Message, Task } from "@a2a-js/sdk";
import { AgentEvent, type AgentExecutor, type ExecutionEventBus, type RequestContext } from "@a2a-js/sdk/server";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { generateText, type ModelMessage, tool } from "ai";
import { z } from "zod";
import type { AgentConfig } from "./config.ts";
import { askUserMessage, parseAskUserResponse, type Question } from "./hitl.ts";
import { log } from "./log.ts";
import { clearPending, loadPending, type PendingPause, savePending } from "./session-state.ts";

const ASK_USER = "ask_user";

const textPart = (value: string) => ({
  content: { $case: "text" as const, value },
  metadata: undefined,
  filename: "",
  mediaType: "text/plain",
});

const askUserTool = tool({
  description:
    "Ask the user a structured question when the task is unclear, instead of guessing. Offer choices when the answer is one of a few options.",
  inputSchema: z.object({
    questions: z
      .array(
        z.object({
          question: z.string().describe("The question to ask"),
          choices: z.array(z.string()).default([]).describe("Options to pick from; empty for a free-text answer"),
          multiple: z.boolean().default(false).describe("Whether more than one choice may be picked"),
        }),
      )
      .min(1),
  }),
});

function userText(message: Message): string {
  return message.parts.flatMap((p) => (p.content?.$case === "text" ? [p.content.value] : [])).join("\n");
}

const status = (state: TaskState, message?: Message) => ({ state, message, timestamp: new Date().toISOString() });

/**
 * Answers each message with a model call through the gateway and replies as an A2A Task.
 * When the model calls ask_user, the task pauses in INPUT_REQUIRED (kagent HITL extension)
 * and the pending pause is saved under the data dir, so a cold start can finish it.
 */
export function createExecutor(config: AgentConfig, dataDir: string): AgentExecutor {
  const model = createOpenAICompatible({ name: "gateway", baseURL: config.baseUrl }).chatModel(config.model);

  return {
    async execute(ctx: RequestContext, bus: ExecutionEventBus): Promise<void> {
      const { taskId, contextId } = ctx;
      const working: Task = ctx.task
        ? { ...ctx.task, status: status(TaskState.TASK_STATE_WORKING) }
        : { id: taskId, contextId, status: status(TaskState.TASK_STATE_WORKING), artifacts: [], history: [ctx.userMessage], metadata: undefined };
      bus.publish(AgentEvent.task(working));
      try {
        await run(ctx, bus);
      } catch (err) {
        log("turn-failed", { message: (err as Error).message });
        publishStatus(bus, taskId, contextId, TaskState.TASK_STATE_FAILED, agentText(contextId, taskId, `failed: ${(err as Error).message}`));
      }
      bus.finished();
    },

    async cancelTask(taskId: string, bus: ExecutionEventBus): Promise<void> {
      bus.finished();
      void taskId;
    },
  };

  async function run(ctx: RequestContext, bus: ExecutionEventBus): Promise<void> {
    const { taskId, contextId } = ctx;
    const pending = loadPending(dataDir, contextId);
    log("turn", { taskId, contextId, pending: pending ? pending.taskId : "", answered: parseAskUserResponse(ctx.userMessage) ? "yes" : "no" });
    let messages: ModelMessage[];
    if (pending && pending.taskId === taskId) {
      const answer = parseAskUserResponse(ctx.userMessage);
      if (!answer || answer.id !== pending.requestId) {
        // Not an answer to the pending question: stay paused on it.
        publishPause(bus, taskId, contextId, pending.requestId, pending.questions);
        return;
      }
      messages = [
        ...(pending.messages as ModelMessage[]),
        {
          role: "tool",
          content: [{ type: "tool-result", toolCallId: pending.toolCallId, toolName: ASK_USER, output: { type: "json", value: { answers: answer.answers } } }],
        },
      ];
    } else {
      messages = [{ role: "user", content: userText(ctx.userMessage) }];
    }

    const result = await generateText({ model, system: config.instruction || undefined, messages, tools: { [ASK_USER]: askUserTool } });

    const call = result.toolCalls.find((c) => c.toolName === ASK_USER);
    if (call) {
      const questions = (call.input as { questions: Question[] }).questions;
      const paused: PendingPause = {
        requestId: randomUUID(),
        taskId,
        toolCallId: call.toolCallId,
        questions,
        messages: [...messages, ...result.response.messages],
      };
      savePending(dataDir, contextId, paused);
      publishPause(bus, taskId, contextId, paused.requestId, questions);
      return;
    }

    clearPending(dataDir, contextId);
    bus.publish(
      AgentEvent.artifactUpdate({
        taskId,
        contextId,
        artifact: { artifactId: randomUUID(), name: "reply", description: "", parts: [textPart(result.text)], metadata: undefined, extensions: [] },
        append: false,
        lastChunk: true,
        metadata: undefined,
      }),
    );
    publishStatus(bus, taskId, contextId, TaskState.TASK_STATE_COMPLETED);
  }
}

function agentText(contextId: string, taskId: string, text: string): Message {
  return { messageId: randomUUID(), contextId, taskId, role: Role.ROLE_AGENT, parts: [textPart(text)], metadata: undefined, extensions: [], referenceTaskIds: [] };
}

function publishStatus(bus: ExecutionEventBus, taskId: string, contextId: string, state: TaskState, message?: Message): void {
  bus.publish(AgentEvent.statusUpdate({ taskId, contextId, status: status(state, message), metadata: undefined }));
}

function publishPause(bus: ExecutionEventBus, taskId: string, contextId: string, requestId: string, questions: Question[]): void {
  publishStatus(bus, taskId, contextId, TaskState.TASK_STATE_INPUT_REQUIRED, askUserMessage({ contextId, taskId, requestId, questions }));
}
