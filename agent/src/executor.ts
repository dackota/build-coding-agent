import { randomUUID } from "node:crypto";
import { Role, TaskState } from "@a2a-js/sdk";
import type { Message, Task } from "@a2a-js/sdk";
import { AgentEvent, type AgentExecutor, type ExecutionEventBus, type RequestContext } from "@a2a-js/sdk/server";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { type ModelMessage, stepCountIs, tool, ToolLoopAgent } from "ai";
import { z } from "zod";
import type { AgentConfig } from "./config.ts";
import { createFileTools } from "./file-tools.ts";
import { askUserMessage, parseAskUserResponse, type Question } from "./hitl.ts";
import { createLocalSandbox } from "./local-sandbox.ts";
import { log } from "./log.ts";
import type { Sandbox } from "./sandbox.ts";
import { clearPending, loadPending, type PendingPause, savePending, workspaceDir } from "./session-state.ts";
import { ChangeTracker } from "./workspace-diff.ts";

const ASK_USER = "ask_user";

export type SandboxKind = "local" | "memory";
export type ExecutorOptions = {
  /** The most model steps (calls) in one turn. */
  maxSteps: number;
  /** "local": the workspace directory itself. "memory": just-bash copy-on-write over it, for tests. */
  sandbox: SandboxKind;
};

const textPart = (value: string, mediaType = "text/plain") => ({
  content: { $case: "text" as const, value },
  metadata: undefined,
  filename: "",
  mediaType,
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

type Attachment = { path: string; content: string };

/** The message's text, and the files it carries (raw parts with a file name). */
function readMessage(message: Message): { text: string; files: Attachment[] } {
  const texts: string[] = [];
  const files: Attachment[] = [];
  for (const p of message.parts) {
    if (p.content?.$case === "text") texts.push(p.content.value);
    else if (p.content?.$case === "raw" && p.filename) files.push({ path: p.filename, content: Buffer.from(p.content.value).toString("utf8") });
  }
  return { text: texts.join("\n"), files };
}

const status = (state: TaskState, message?: Message) => ({ state, message, timestamp: new Date().toISOString() });

/**
 * Runs each message through a tool loop (file tools on the context's Sandbox, and ask_user)
 * with the model behind the gateway, and replies as an A2A Task: the model's text, and a
 * unified diff of what the turn changed. A turn ends at the step limit. When the model calls
 * ask_user, the task pauses in INPUT_REQUIRED (kagent HITL extension) and the pending pause
 * is saved under the data dir, so a cold start can finish it.
 */
export function createExecutor(config: AgentConfig, dataDir: string, opts: ExecutorOptions): AgentExecutor {
  const model = createOpenAICompatible({ name: "gateway", baseURL: config.baseUrl }).chatModel(config.model);
  const sandboxes = new Map<string, Promise<Sandbox>>();

  function sandboxFor(contextId: string): Promise<Sandbox> {
    let sandbox = sandboxes.get(contextId);
    if (!sandbox) {
      const root = workspaceDir(dataDir, contextId);
      sandbox = opts.sandbox === "memory" ? import("./memory-sandbox.ts").then((m) => m.createMemorySandbox(root)) : createLocalSandbox(root);
      sandboxes.set(contextId, sandbox);
    }
    return sandbox;
  }

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
    const sandbox = await sandboxFor(contextId);
    let messages: ModelMessage[];
    let changes: ChangeTracker;
    if (pending && pending.taskId === taskId) {
      const answer = parseAskUserResponse(ctx.userMessage);
      if (!answer || answer.id !== pending.requestId) {
        // Not an answer to the pending question: stay paused on it.
        publishPause(bus, taskId, contextId, pending.requestId, pending.questions);
        return;
      }
      changes = new ChangeTracker(pending.baseline);
      messages = [
        ...(pending.messages as ModelMessage[]),
        {
          role: "tool",
          content: [{ type: "tool-result", toolCallId: pending.toolCallId, toolName: ASK_USER, output: { type: "json", value: { answers: answer.answers } } }],
        },
      ];
    } else {
      changes = new ChangeTracker();
      const { text, files } = readMessage(ctx.userMessage);
      // Attached files are the turn's starting point: written before the baseline, so not in the diff.
      for (const f of files) await sandbox.writeFile(f.path, f.content);
      const listing = files.length > 0 ? `\n\nFiles in the workspace: ${files.map((f) => f.path).join(", ")}` : "";
      messages = [{ role: "user", content: `${text}${listing}` }];
    }

    const agent = new ToolLoopAgent({
      model,
      instructions: config.instruction || undefined,
      tools: { ...createFileTools(sandbox, changes), [ASK_USER]: askUserTool },
      stopWhen: stepCountIs(opts.maxSteps),
    });
    const result = await agent.generate({ messages });

    const call = result.toolCalls.find((c) => c.toolName === ASK_USER);
    if (call) {
      const questions = (call.input as { questions: Question[] }).questions;
      const paused: PendingPause = {
        requestId: randomUUID(),
        taskId,
        toolCallId: call.toolCallId,
        questions,
        messages: [...messages, ...result.response.messages],
        baseline: changes.baseline(),
      };
      savePending(dataDir, contextId, paused);
      publishPause(bus, taskId, contextId, paused.requestId, questions);
      return;
    }

    clearPending(dataDir, contextId);
    const isAtStepLimit = result.finishReason === "tool-calls" && result.steps.length >= opts.maxSteps;
    if (isAtStepLimit) log("step-limit", { taskId, steps: result.steps.length });
    const reply = isAtStepLimit
      ? `Stopped: the step limit (${opts.maxSteps} steps) was reached before the task was done. The diff shows the changes so far.`
      : result.text;
    publishArtifact(bus, taskId, contextId, "reply", textPart(reply));
    const diff = await changes.diff(sandbox);
    if (diff) publishArtifact(bus, taskId, contextId, "diff", textPart(diff, "text/x-diff"));
    publishStatus(bus, taskId, contextId, TaskState.TASK_STATE_COMPLETED);
  }
}

function publishArtifact(bus: ExecutionEventBus, taskId: string, contextId: string, name: string, part: ReturnType<typeof textPart>): void {
  bus.publish(
    AgentEvent.artifactUpdate({
      taskId,
      contextId,
      artifact: { artifactId: randomUUID(), name, description: "", parts: [part], metadata: undefined, extensions: [] },
      append: false,
      lastChunk: true,
      metadata: undefined,
    }),
  );
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
