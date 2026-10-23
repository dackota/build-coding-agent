import { randomUUID } from "node:crypto";
import { Role, TaskState } from "@a2a-js/sdk";
import type { Message, Task } from "@a2a-js/sdk";
import { AgentEvent, type AgentExecutor, type ExecutionEventBus, type RequestContext } from "@a2a-js/sdk/server";
import { type ModelMessage, stepCountIs, type Tool, tool, ToolLoopAgent } from "ai";
import { z } from "zod";
import type { AgentConfig, McpBinding } from "./config.ts";
import { capTools, logStepUsage, pruneMessages } from "./context.ts";
import { createFileTools } from "./file-tools.ts";
import { approvalHint, pendingTools, resumeApproval, turnGate } from "./approval.ts";
import { gatewayModel } from "./gateway.ts";
import { askUserMessage, parseAskUserResponse, parseToolApprovalResponse, type Question, toolApprovalMessage } from "./hitl.ts";
import { createLocalSandbox } from "./local-sandbox.ts";
import { log } from "./log.ts";
import { createTodoTool, formatTodos, TODO_TOOL, type TodoHolder } from "./todo-tool.ts";
import { createSkillTool, discoverSkills, type Skill } from "./skills.ts";
import { readIfExists, type Sandbox, type SandboxHooks, withHooks } from "./sandbox.ts";
import { AGENTS_MD_FILE, ASK_USER_TOOL, buildSystemPrompt } from "./system-prompt.ts";
import { type AskUserPause, loadSession, saveSession, type SessionState, type Todo, type ToolApprovalPause, workspaceDir } from "./session-state.ts";
import { openMcpTools } from "./mcp-tools.ts";
import { type ApprovalGate, createShellTool, SHELL_TOOL } from "./shell-tool.ts";
import { createTaskTool } from "./subagents.ts";
import { eventWrap, type LoadedExtension, registerExtensionTools } from "./extensions.ts";
import { createToolRegistry, type ToolRegistry, type TurnContext } from "./tool-registry.ts";
import { EVENT_KEY, type StreamEvent } from "./stream-events.ts";
import { ChangeTracker } from "./workspace-diff.ts";

const ASK_USER = ASK_USER_TOOL;
const LOG_FIELD_MAX_CHARS = 200;
const TEXT_FLUSH_MS = 150;

/** The lifecycle hooks of one session's sandbox: each writes a log line the actor's log carries. */
function hooksFor(contextId: string): SandboxHooks {
  return {
    afterStart: () => log("afterStart", { contextId }),
    beforeStop: () => log("beforeStop", { contextId }),
    onTimeout: (command) => log("onTimeout", { contextId, command: command.slice(0, LOG_FIELD_MAX_CHARS) }),
  };
}

/** Stops each started sandbox; one whose start failed is logged and skipped, never a reason to leave the rest running. */
async function stopAll(started: Promise<Sandbox>[]): Promise<void> {
  await Promise.all(
    started.map((s) =>
      s.then(
        (sandbox) => sandbox.stop(),
        (err: Error) => log("shutdown-skipped", { message: err.message }),
      ),
    ),
  );
}

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

const LOAD_SKILL_TOOL = "load_skill";
const TASK_TOOL = "task";
const FILE_TOOLS = ["read_file", "write_file", "edit_file", "search"] as const;

const askUserTool = tool({
  description: `Ask the user one or more structured questions and wait for the answers. Returns one answer list per question, in order.

WHEN TO USE: the task is unclear or has several reasonable readings; a choice only the user can make (a name, a colour, which file).

WHEN NOT TO USE: facts you can find in the workspace (use read_file or search); asking permission to run a command (the shell tool asks on its own).

DO NOT USE FOR: confirming work you can check yourself, or chatting.

USAGE: offer choices when the answer is one of a few options; leave choices empty for a free-text answer; set multiple when more than one choice may be picked.

EXAMPLES:
  - Which colour should the button be? choices ["red", "blue"]
  - What should the new module be called? choices []`,
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

/** What a turn runs with: the conversation so far, the diff tracker, and what the user approved. */
type Turn = {
  messages: ModelMessage[];
  changes: ChangeTracker;
  /** Tool calls the user approved once, by call id. */
  approvedCalls: ReadonlySet<string>;
  /** Risk kinds approved for the rest of the session, with any this answer adds. */
  approvedKinds: string[];
};

/** The parts of a generate result that end a turn. */
type TurnResult = {
  content: readonly { type: string }[];
  toolCalls: readonly ({ toolName: string; toolCallId: string; input: unknown } | undefined)[];
  response: { messages: ModelMessage[] };
  text: string;
  finishReason: string;
  steps: readonly unknown[];
};

type TurnIds = { taskId: string; contextId: string };

/** A step that pauses: it calls ask_user, or holds a call for approval. Its calls have no result yet. */
const isPausingStep = (step: Pick<TurnResult, "content" | "toolCalls">): boolean =>
  step.toolCalls.some((c) => c?.toolName === ASK_USER) || step.content.some((p) => p.type === "tool-approval-request");

/** The file tools built earlier this turn, by name. */
function builtFileTools(ctx: TurnContext): Record<string, Tool> {
  const out: Record<string, Tool> = {};
  for (const name of FILE_TOOLS) {
    const built = ctx.built(name);
    if (built) out[name] = built;
  }
  return out;
}

/** The built-in tools, once per executor, in the order the system prompt lists them. */
function registerBuiltins(registry: ToolRegistry, config: AgentConfig, opts: ExecutorOptions): void {
  for (const name of FILE_TOOLS) registry.register(name, (ctx) => createFileTools(ctx.sandbox, ctx.changes)[name]);
  registry.register(SHELL_TOOL, (ctx) => createShellTool(ctx.sandbox, ctx.gate));
  registry.register(ASK_USER, () => askUserTool);
  registry.register(TODO_TOOL, (ctx) => createTodoTool(ctx.todos));
  registry.register(LOAD_SKILL_TOOL, (ctx) => (ctx.skills.length > 0 ? createSkillTool(ctx.skills, ctx.taskId) : undefined));
  registry.register(TASK_TOOL, (ctx) => {
    if (config.subAgents.length === 0) return undefined;
    return createTaskTool(config.subAgents, { fileTools: builtFileTools(ctx), taskId: ctx.taskId, opts });
  });
}

/**
 * Runs each message through a tool loop (file tools and the shell on the context's Sandbox,
 * ask_user, and the tools of the config's MCP bindings) with the model behind the gateway, and replies as an A2A Task: the model's
 * text, and a unified diff of what the turn changed. A turn ends at the step limit. When the
 * model calls ask_user, or a call the safety gate holds (a risky shell command, or any tool of
 * an MCP binding with requireApproval), the task pauses in
 * INPUT_REQUIRED (kagent HITL extension: ask_user_request or tool_approval_request) and the
 * pending pause is saved in the session state, so a cold start can finish it.
 */
export function createExecutor(
  config: AgentConfig,
  dataDir: string,
  opts: ExecutorOptions,
  mcpBindings: readonly McpBinding[] = [],
  extensions: readonly LoadedExtension[] = [],
): AgentExecutor & { shutdown(): Promise<void> } {
  const model = gatewayModel(config.baseUrl, config.model);
  // Every tool the registry builds (MCP, built-in, custom) goes through the extensions' tool_call
  // handlers; capTools wraps the result, so a block reason or handler error is capped too.
  const registry = createToolRegistry(eventWrap(extensions));
  registerBuiltins(registry, config, opts);
  registerExtensionTools(registry, extensions);
  const sandboxes = new Map<string, Promise<Sandbox>>();
  /** The running turn of each task, so CancelTask can stop it. */
  const running = new Map<string, { abort: AbortController; contextId: string }>();

  function sandboxFor(contextId: string): Promise<Sandbox> {
    let sandbox = sandboxes.get(contextId);
    if (!sandbox) {
      const root = workspaceDir(dataDir, contextId);
      const inner = opts.sandbox === "memory" ? import("./memory-sandbox.ts").then((m) => m.createMemorySandbox(root)) : createLocalSandbox(root);
      sandbox = inner.then((s) => withHooks(s, hooksFor(contextId)));
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
      const abort = new AbortController();
      running.set(taskId, { abort, contextId });
      try {
        await run(ctx, bus, abort.signal);
      } catch (err) {
        // A cancelled turn already published its canceled status.
        if (abort.signal.aborted) log("turn-canceled", { taskId, message: (err as Error).message });
        else {
          log("turn-failed", { message: (err as Error).message });
          publishStatus(bus, taskId, contextId, TaskState.TASK_STATE_FAILED, agentText(contextId, taskId, `failed: ${(err as Error).message}`));
        }
      } finally {
        running.delete(taskId);
      }
      if (!abort.signal.aborted) bus.finished();
    },

    /** Stops every sandbox this executor started, so each runs its beforeStop hook. */
    async shutdown(): Promise<void> {
      const started = [...sandboxes.values()];
      sandboxes.clear();
      await stopAll(started);
    },

    /** Stops the running turn; the steps that finished stay in the session, so the next message continues it. */
    async cancelTask(taskId: string, bus: ExecutionEventBus): Promise<void> {
      const turn = running.get(taskId);
      turn?.abort.abort();
      if (turn) publishStatus(bus, taskId, turn.contextId, TaskState.TASK_STATE_CANCELED);
      bus.finished();
    },
  };

  /** The system prompt for this turn: config, runtime facts, contract, and the workspace's AGENTS.md. */
  async function turnInstructions(sandbox: Sandbox, taskId: string, tools: object, workspace: string, skills: Skill[], todos: Todo[]): Promise<string> {
    const agentsMd = await readIfExists(sandbox, AGENTS_MD_FILE);
    const prompt = buildSystemPrompt({ instruction: config.instruction, toolNames: Object.keys(tools), workspace, maxSteps: opts.maxSteps, agentsMd, skills, todos });
    log("system-prompt", { taskId, agentsMd: agentsMd ? "yes" : "no", skills: skills.map((s) => s.name).join(","), prompt: JSON.stringify(prompt) });
    return prompt;
  }

  async function run(ctx: RequestContext, bus: ExecutionEventBus, signal: AbortSignal): Promise<void> {
    const { taskId, contextId } = ctx;
    // Everything the session knows comes from disk: a wake is a cold start.
    const loaded = loadSession(dataDir, contextId);
    log("turn", { taskId, contextId, pending: loaded.pending ? loaded.pending.taskId : "", answered: parseAskUserResponse(ctx.userMessage) ? "yes" : "no" });
    const sandbox = await sandboxFor(contextId);
    const turn = await startTurn(ctx, bus, loaded, sandbox);
    if (!turn) return;
    const base: SessionState = turn.approvedKinds.length > 0 ? { ...loaded, approvedKinds: turn.approvedKinds } : loaded;
    const todos: TodoHolder = { list: loaded.todos };
    const result = await generateTurn(ctx, bus, signal, sandbox, turn, base, todos);
    if (signal.aborted) throw new Error("canceled");
    const session: SessionState = { ...base, todos: todos.list };
    const ids = { taskId, contextId };
    if (pauseOnApproval(bus, ids, session, turn, result)) return;
    if (pauseOnAskUser(bus, ids, session, turn, result)) return;
    saveSession(dataDir, contextId, { ...session, messages: [...turn.messages, ...result.response.messages], pending: undefined });
    await publishReply(bus, ids, sandbox, turn.changes, result, session.todos);
  }

  /** Runs the turn with this turn's MCP clients open, and closes them after. */
  async function generateTurn(ctx: RequestContext, bus: ExecutionEventBus, signal: AbortSignal, sandbox: Sandbox, turn: Turn, session: SessionState, todos: TodoHolder): Promise<TurnResult> {
    const skills = await discoverSkills(sandbox);
    const gate = turnGate(turn.approvedCalls, turn.approvedKinds);
    const mcp = await openMcpTools(mcpBindings, gate);
    try {
      return await runAgent(ctx, bus, signal, sandbox, turn, session, todos, skills, gate, mcp.tools);
    } finally {
      await mcp.close();
    }
  }

  async function runAgent(
    ctx: RequestContext,
    bus: ExecutionEventBus,
    signal: AbortSignal,
    sandbox: Sandbox,
    turn: Turn,
    session: SessionState,
    todos: TodoHolder,
    skills: Skill[],
    gate: ApprovalGate,
    mcpTools: Record<string, Tool>,
  ): Promise<TurnResult> {
    const { taskId, contextId } = ctx;
    const tools = capTools(registry.build({ sandbox, changes: turn.changes, taskId, skills, gate, todos }, mcpTools), opts.maxToolOutputChars);
    const instructions = await turnInstructions(sandbox, taskId, tools, workspaceDir(dataDir, contextId), skills, todos.list);
    const agent = new ToolLoopAgent({ model, instructions, tools, stopWhen: stepCountIs(opts.maxSteps) });
    let stepNumber = 0;
    const stream = await agent.stream({
      abortSignal: signal,
      // Old tool results are pruned for the model only; the saved session keeps them.
      messages: pruneMessages(turn.messages),
      // Save after every step, so a crash mid-turn keeps the steps that finished. A step that
      // pauses is saved as the pause instead.
      onStepFinish: (step) => {
        stepNumber++;
        logStepUsage(taskId, stepNumber, step.usage);
        if (isPausingStep(step)) return;
        saveSession(dataDir, contextId, { ...session, todos: todos.list, messages: [...turn.messages, ...step.response.messages] });
      },
    });
    await publishStream(bus, { taskId, contextId }, signal, stream.fullStream);
    return finishedTurn(stream);
  }

  /**
   * Pauses on the calls the safety gate holds, if any: saves the pause and publishes a
   * tool_approval_request. The paused turn lives in the pause; the conversation stays as it was.
   */
  function pauseOnApproval(bus: ExecutionEventBus, ids: TurnIds, session: SessionState, turn: Turn, result: TurnResult): boolean {
    const held = pendingTools(result.content);
    if (held.length === 0) return false;
    const paused: ToolApprovalPause = {
      kind: "tool_approval",
      taskId: ids.taskId,
      hint: approvalHint(held),
      tools: held,
      messages: [...turn.messages, ...result.response.messages],
      baseline: turn.changes.baseline(),
    };
    saveSession(dataDir, ids.contextId, { ...session, pending: paused });
    log("approval-pause", { taskId: ids.taskId, tools: held.map((t) => `${t.name}:${t.kinds.join(",")}`).join(" ") });
    publishApprovalPause(bus, ids.taskId, ids.contextId, paused);
    return true;
  }

  /** Pauses on an ask_user call, if the turn made one: saves the pause and publishes an ask_user_request. */
  function pauseOnAskUser(bus: ExecutionEventBus, ids: TurnIds, session: SessionState, turn: Turn, result: TurnResult): boolean {
    const call = result.toolCalls.find((c) => c?.toolName === ASK_USER);
    if (!call) return false;
    const questions = (call.input as { questions: Question[] }).questions;
    const paused: AskUserPause = {
      requestId: randomUUID(),
      taskId: ids.taskId,
      toolCallId: call.toolCallId,
      questions,
      messages: [...turn.messages, ...result.response.messages],
      baseline: turn.changes.baseline(),
    };
    saveSession(dataDir, ids.contextId, { ...session, pending: paused });
    publishPause(bus, ids.taskId, ids.contextId, paused.requestId, questions);
    return true;
  }

  /** The finished turn's reply and diff, then the completed status. */
  async function publishReply(bus: ExecutionEventBus, ids: TurnIds, sandbox: Sandbox, changes: ChangeTracker, result: TurnResult, todos: Todo[]): Promise<void> {
    const { taskId, contextId } = ids;
    const isAtStepLimit = result.finishReason === "tool-calls" && result.steps.length >= opts.maxSteps;
    if (isAtStepLimit) log("step-limit", { taskId, steps: result.steps.length });
    const reply = isAtStepLimit
      ? `Stopped: the step limit (${opts.maxSteps} steps) was reached before the task was done. The diff shows the changes so far.`
      : result.text;
    publishArtifact(bus, taskId, contextId, "reply", textPart(reply));
    if (todos.length > 0) publishArtifact(bus, taskId, contextId, "todos", textPart(`Todo list:\n${formatTodos(todos)}`));
    const diff = await changes.diff(sandbox);
    if (diff) publishArtifact(bus, taskId, contextId, "diff", textPart(diff, "text/x-diff"));
    publishStatus(bus, taskId, contextId, TaskState.TASK_STATE_COMPLETED);
  }
}

/** The turn to run: a resumed pause, or the new message after the history. Undefined when the task stays paused. */
async function startTurn(ctx: RequestContext, bus: ExecutionEventBus, session: SessionState, sandbox: Sandbox): Promise<Turn | undefined> {
  const approvedKinds = session.approvedKinds ?? [];
  const pending = session.pending?.taskId === ctx.taskId ? session.pending : undefined;
  if (pending?.kind === "tool_approval") return resumeToolApproval(ctx, bus, pending, approvedKinds);
  if (pending) return resumeAskUser(ctx, bus, pending, approvedKinds);
  const { text, files } = readMessage(ctx.userMessage);
  // Attached files are the turn's starting point: written before the baseline, so not in the diff.
  for (const f of files) await sandbox.writeFile(f.path, f.content);
  const listing = files.length > 0 ? `\n\nFiles in the workspace: ${files.map((f) => f.path).join(", ")}` : "";
  const messages: ModelMessage[] = [...(session.messages as ModelMessage[]), { role: "user", content: `${text}${listing}` }];
  return { messages, changes: new ChangeTracker(), approvedCalls: new Set(), approvedKinds };
}

/** Resumes a tool approval pause, or keeps the task paused when the answer does not decide each pending call. */
function resumeToolApproval(ctx: RequestContext, bus: ExecutionEventBus, pending: ToolApprovalPause, approvedKinds: string[]): Turn | undefined {
  const { taskId, contextId } = ctx;
  const resumed = resumeApproval(pending, parseToolApprovalResponse(ctx.userMessage));
  if (!resumed) {
    publishApprovalPause(bus, taskId, contextId, pending);
    return undefined;
  }
  log("approval", { taskId, approved: resumed.approvedCalls.size, of: pending.tools.length, session: resumed.sessionKinds.join(",") });
  return {
    messages: resumed.messages,
    changes: new ChangeTracker(pending.baseline),
    approvedCalls: resumed.approvedCalls,
    approvedKinds: [...new Set([...approvedKinds, ...resumed.sessionKinds])].sort(),
  };
}

/** Resumes an ask_user pause with the answers, or keeps the task paused when the message does not answer it. */
function resumeAskUser(ctx: RequestContext, bus: ExecutionEventBus, pending: AskUserPause, approvedKinds: string[]): Turn | undefined {
  const answer = parseAskUserResponse(ctx.userMessage);
  if (!answer || answer.id !== pending.requestId) {
    publishPause(bus, ctx.taskId, ctx.contextId, pending.requestId, pending.questions);
    return undefined;
  }
  const answers: ModelMessage = {
    role: "tool",
    content: [{ type: "tool-result", toolCallId: pending.toolCallId, toolName: ASK_USER, output: { type: "json", value: { answers: answer.answers } } }],
  };
  return { messages: [...(pending.messages as ModelMessage[]), answers], changes: new ChangeTracker(pending.baseline), approvedCalls: new Set(), approvedKinds };
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

/** The parts of a stream result that end a turn, once the stream is read. */
async function finishedTurn(stream: {
  content: PromiseLike<TurnResult["content"]>;
  toolCalls: PromiseLike<TurnResult["toolCalls"]>;
  response: PromiseLike<TurnResult["response"]>;
  text: PromiseLike<string>;
  finishReason: PromiseLike<string>;
  steps: PromiseLike<TurnResult["steps"]>;
}): Promise<TurnResult> {
  return {
    content: await stream.content,
    toolCalls: await stream.toolCalls,
    response: await stream.response,
    text: await stream.text,
    finishReason: await stream.finishReason,
    steps: await stream.steps,
  };
}

/**
 * Sends tool calls and text out as they happen; the finished turn is read from the stream after.
 * Every progress event is a task save at the controller, so text deltas are batched.
 */
async function publishStream(bus: ExecutionEventBus, ids: TurnIds, signal: AbortSignal, parts: AsyncIterable<{ type: string; [k: string]: any }>): Promise<void> {
  let pendingText = "";
  let lastFlush = 0;
  const flushText = () => {
    if (pendingText && !signal.aborted) publishProgress(bus, ids.taskId, ids.contextId, { type: "text_delta", text: pendingText });
    pendingText = "";
    lastFlush = Date.now();
  };
  for await (const part of parts) {
    if (part.type === "text-delta") {
      pendingText += part.text;
      if (Date.now() - lastFlush >= TEXT_FLUSH_MS) flushText();
    } else if (part.type === "tool-call") {
      flushText();
      publishProgress(bus, ids.taskId, ids.contextId, { type: "tool_call", name: part.toolName, args: part.input });
    } else if (part.type === "error") throw part.error;
  }
  flushText();
}

function publishProgress(bus: ExecutionEventBus, taskId: string, contextId: string, event: StreamEvent): void {
  const text = event.type === "text_delta" ? event.text : "";
  const message: Message = { ...agentText(contextId, taskId, text), metadata: { [EVENT_KEY]: event } };
  publishStatus(bus, taskId, contextId, TaskState.TASK_STATE_WORKING, message);
}

function agentText(contextId: string, taskId: string, text: string): Message {
  return { messageId: randomUUID(), contextId, taskId, role: Role.ROLE_AGENT, parts: [textPart(text)], metadata: undefined, extensions: [], referenceTaskIds: [] };
}

function publishStatus(bus: ExecutionEventBus, taskId: string, contextId: string, state: TaskState, message?: Message): void {
  bus.publish(AgentEvent.statusUpdate({ taskId, contextId, status: status(state, message), metadata: undefined }));
}

function publishApprovalPause(bus: ExecutionEventBus, taskId: string, contextId: string, pause: ToolApprovalPause): void {
  const tools = pause.tools.map(({ id, call_id, name, args }) => ({ id, call_id, name, args }));
  publishStatus(bus, taskId, contextId, TaskState.TASK_STATE_INPUT_REQUIRED, toolApprovalMessage({ contextId, taskId, hint: pause.hint, tools }));
}

function publishPause(bus: ExecutionEventBus, taskId: string, contextId: string, requestId: string, questions: Question[]): void {
  publishStatus(bus, taskId, contextId, TaskState.TASK_STATE_INPUT_REQUIRED, askUserMessage({ contextId, taskId, requestId, questions }));
}
