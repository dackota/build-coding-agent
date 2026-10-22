import { randomUUID } from "node:crypto";
import { Role, TaskState } from "@a2a-js/sdk";
import type { Message, Task } from "@a2a-js/sdk";
import { AgentEvent, type AgentExecutor, type ExecutionEventBus, type RequestContext } from "@a2a-js/sdk/server";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { type ModelMessage, stepCountIs, tool, ToolLoopAgent } from "ai";
import { z } from "zod";
import type { AgentConfig } from "./config.ts";
import { capTools, pruneMessages } from "./context.ts";
import { createFileTools } from "./file-tools.ts";
import { askUserMessage, parseAskUserResponse, type Question } from "./hitl.ts";
import { createLocalSandbox } from "./local-sandbox.ts";
import { log } from "./log.ts";
import { createSkillTool, discoverSkills, type Skill } from "./skills.ts";
import { readIfExists, type Sandbox } from "./sandbox.ts";
import { AGENTS_MD_FILE, buildSystemPrompt } from "./system-prompt.ts";
import { loadSession, type PendingPause, saveSession, workspaceDir } from "./session-state.ts";
import { ChangeTracker } from "./workspace-diff.ts";

const ASK_USER = "ask_user";

export type SandboxKind = "local" | "memory";
export type ExecutorOptions = {
  /** The most model steps (calls) in one turn. */
  maxSteps: number;
  /** "local": the workspace directory itself. "memory": just-bash copy-on-write over it, for tests. */
  sandbox: SandboxKind;
  /** The most characters of any one tool result; longer output is cut with a truncation marker. */
  maxToolOutputChars: number;
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

  /** The system prompt for this turn: config, runtime facts, contract, and the workspace's AGENTS.md. */
  async function turnInstructions(sandbox: Sandbox, taskId: string, tools: object, workspace: string, skills: Skill[]): Promise<string> {
    const agentsMd = await readIfExists(sandbox, AGENTS_MD_FILE);
    const prompt = buildSystemPrompt({ instruction: config.instruction, toolNames: Object.keys(tools), workspace, maxSteps: opts.maxSteps, agentsMd, skills });
    log("system-prompt", { taskId, agentsMd: agentsMd ? "yes" : "no", skills: skills.map((s) => s.name).join(","), prompt: JSON.stringify(prompt) });
    return prompt;
  }

  async function run(ctx: RequestContext, bus: ExecutionEventBus): Promise<void> {
    const { taskId, contextId } = ctx;
    // Everything the session knows comes from disk: a wake is a cold start.
    const session = loadSession(dataDir, contextId);
    const history = session.messages as ModelMessage[];
    const { pending } = session;
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
      messages = [...history, { role: "user", content: `${text}${listing}` }];
    }

    const skills = await discoverSkills(sandbox);
    const tools = capTools(
      { ...createFileTools(sandbox, changes), [ASK_USER]: askUserTool, ...(skills.length > 0 ? { load_skill: createSkillTool(skills, taskId) } : {}) },
      opts.maxToolOutputChars,
    );
    const instructions = await turnInstructions(sandbox, taskId, tools, workspaceDir(dataDir, contextId), skills);
    const agent = new ToolLoopAgent({
      model,
      instructions,
      tools,
      stopWhen: stepCountIs(opts.maxSteps),
    });
    let stepNumber = 0;
    const result = await agent.generate({
      // Old tool results are pruned for the model only; the saved session keeps them.
      messages: pruneMessages(messages),
      // Save after every step, so a crash mid-turn keeps the steps that finished. A step that
      // calls ask_user is saved as the pause below instead: its call has no result yet.
      onStepFinish: (step) => {
        stepNumber++;
        log("step-usage", {
          taskId,
          step: stepNumber,
          inputTokens: step.usage.inputTokens ?? 0,
          outputTokens: step.usage.outputTokens ?? 0,
          cachedTokens: step.usage.inputTokenDetails?.cacheReadTokens ?? 0,
        });
        if (step.toolCalls.some((c) => c?.toolName === ASK_USER)) return;
        saveSession(dataDir, contextId, { ...session, messages: [...messages, ...step.response.messages] });
      },
    });

    const call = result.toolCalls.find((c) => c?.toolName === ASK_USER);
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
      // The paused turn lives in the pause until it is answered; the conversation stays as it was.
      saveSession(dataDir, contextId, { ...session, messages: history, pending: paused });
      publishPause(bus, taskId, contextId, paused.requestId, questions);
      return;
    }

    saveSession(dataDir, contextId, { messages: [...messages, ...result.response.messages], todos: session.todos });
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
