// The implement loop's runner: reads /implement before any model call, then does each action the
// step machine (loop.ts) asks for and feeds the result back as an event. The loop state is saved
// after every step, so a cold wake goes on from the last step. The one pause is the start approval:
// a tool_approval_request naming the exact commands, branch and repo; the loop's own calls after it
// need no second approval.
import { randomUUID } from "node:crypto";
import type { Message } from "@a2a-js/sdk";
import type { Tool } from "ai";
import { z } from "zod";
import type { SubAgentDef } from "./config.ts";
import { parseToolApprovalResponse } from "./hitl.ts";
import { type Action, begin, isOpen, type Issue, type LoopEvent, type LoopState, type Next, next, parseImplementCommand, type Target } from "./loop.ts";
import { findCommands } from "./loop-commands.ts";
import { type Github, openGithub } from "./loop-github.ts";
import { log } from "./log.ts";
import { readIfExists, type Sandbox, shellQuote } from "./sandbox.ts";
import { saveSession, type SessionState, type ToolApprovalPause } from "./session-state.ts";
import type { StreamEvent } from "./stream-events.ts";
import { runSubAgent } from "./subagents.ts";
import { ChangeTracker } from "./workspace-diff.ts";
import type { McpBinding } from "./config.ts";

export const START_TOOL = "implement_start";
const START_CALL_ID = "implement-start";
const OUTPUT_TAIL_CHARS = 1500;
const MAX_CHANGED_FILES_IN_BODY = 20;

/** What the runner needs from the executor. */
export type LoopEnv = {
  dataDir: string;
  taskId: string;
  contextId: string;
  sandbox: Sandbox;
  bindings: readonly McpBinding[];
  subAgents: readonly SubAgentDef[];
  /** The loop's own command timeout, and where it clones from. */
  commandTimeoutMs: number;
  gitBaseUrl: string;
  subAgentOpts: { maxSteps: number; maxToolOutputChars: number };
  /** The file tools of the registry, built for this change tracker (extensions included). */
  fileTools: (changes: ChangeTracker) => Record<string, Tool>;
  signal: AbortSignal;
};

/** How the runner talks to the user. */
export type LoopIo = {
  progress(event: StreamEvent): void;
  /** Publishes the pause (INPUT_REQUIRED); the runner has saved it. */
  pause(pause: ToolApprovalPause): void;
  /** The run's reply: the task completes with this text. */
  reply(text: string): Promise<void>;
};

const readyAnswer = z.object({ ready: z.boolean(), reason: z.string() });

function startHint(action: Extract<Action, { kind: "approve" }>, number: number): string {
  const setup = action.setup ? `\`${action.setup}\`` : "none";
  return `Implement ${action.repo}#${number}? Setup: ${setup}. Test: \`${action.test}\`. Branch: ${action.branch}. The pull request goes to ${action.repo}. After you approve, the loop runs these two commands and opens the pull request with no further question.`;
}

function startPause(taskId: string, action: Extract<Action, { kind: "approve" }>, number: number): ToolApprovalPause {
  return {
    kind: "tool_approval",
    taskId,
    hint: startHint(action, number),
    tools: [
      {
        id: randomUUID(),
        call_id: START_CALL_ID,
        name: START_TOOL,
        args: { repo: action.repo, branch: action.branch, ...(action.setup ? { setup: action.setup } : {}), test: action.test },
        kinds: [],
      },
    ],
    messages: [],
  };
}

const issueText = (target: Target, issue: Issue): string =>
  `GitHub issue ${target.owner}/${target.repo}#${target.number}: ${issue.title}\n\n${issue.body}\n${issue.comments.length > 0 ? `\nComments:\n${issue.comments.map((c) => `- ${c}`).join("\n")}\n` : ""}`;

function readyPrompt(target: Target, issue: Issue, previousError?: string): string {
  return `Decide whether this GitHub issue is ready to build. It is ready when it says what to build and has testable acceptance criteria. You may read the repository (read_file, search) to check. Reply with only a JSON object: {"ready": true or false, "reason": "one sentence"}.${previousError ? `\n\nYour last reply was not valid (${previousError}). Reply with only the JSON object.` : ""}\n\n${issueText(target, issue)}`;
}

/** The JSON object in a reply (the first `{` to the last `}`), checked against the schema. */
function parseReady(text: string): z.infer<typeof readyAnswer> {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end < start) throw new Error("no JSON object");
  return readyAnswer.parse(JSON.parse(text.slice(start, end + 1)));
}

const tail = (text: string): string => (text.length > OUTPUT_TAIL_CHARS ? `...${text.slice(-OUTPUT_TAIL_CHARS)}` : text);

function pullRequestBody(state: LoopState, target: Target): string {
  const test = state.commands?.test ?? "";
  const files = (state.changedFiles ?? []).slice(0, MAX_CHANGED_FILES_IN_BODY).map((f) => `- ${f}`).join("\n");
  return [
    `Implements ${target.owner}/${target.repo}#${target.number} (https://github.com/${target.owner}/${target.repo}/issues/${target.number}).`,
    `Test result: \`${test}\` passed.\n\n\`\`\`\n${tail(state.testOutput ?? "").trim()}\n\`\`\``,
    `Changed files:\n${files}`,
    `Closes #${target.number}`,
  ].join("\n\n");
}

async function withGithub<T>(env: LoopEnv, use: (gh: Github) => Promise<T>): Promise<T> {
  const gh = await openGithub(env.bindings);
  try {
    return await use(gh);
  } finally {
    await gh.close();
  }
}

/** Clears a previous run's files from the workspace, or says why it cannot clone into it. */
async function prepareWorkspace(env: LoopEnv, hadPriorRun: boolean): Promise<void> {
  const listing = await env.sandbox.exec("ls -A");
  if (listing.stdout.trim() === "") return;
  if (!hadPriorRun) throw new Error("the workspace already has files; the loop clones into an empty workspace");
  const wiped = await env.sandbox.exec("find . -mindepth 1 -delete");
  if (wiped.exitCode !== 0) throw new Error("could not clear the previous run from the workspace");
}

async function readAndClone(env: LoopEnv, state: LoopState, hadPriorRun: boolean): Promise<LoopEvent> {
  const issue = await withGithub(env, (gh) => gh.readIssue(state.target));
  await prepareWorkspace(env, hadPriorRun);
  const { owner, repo } = state.target;
  const url = `${env.gitBaseUrl}/${owner}/${repo}.git`;
  const clone = await env.sandbox.exec(`git clone --depth 1 ${shellQuote(url)} .`, { timeoutMs: env.commandTimeoutMs });
  if (clone.exitCode !== 0) return { type: "failed", code: "clone-failed", reason: `could not clone ${owner}/${repo}: ${clone.stderr.trim().split("\n").at(-1) ?? ""}` };
  const head = await env.sandbox.exec("git rev-parse --abbrev-ref HEAD");
  return { type: "read", issue, baseBranch: head.stdout.trim() || "main" };
}

function subAgent(env: LoopEnv, name: string): SubAgentDef {
  const def = env.subAgents.find((d) => d.name === name);
  if (!def) throw new Error(`the agent config has no ${name} subagent`);
  return def;
}

async function readyCheck(env: LoopEnv, state: LoopState): Promise<LoopEvent> {
  const issue = state.issue!;
  const deps = { fileTools: env.fileTools(new ChangeTracker()), taskId: env.taskId, opts: env.subAgentOpts };
  let error: string | undefined;
  for (let attempt = 0; attempt < 2; attempt++) {
    const text = await runSubAgent(subAgent(env, "explorer"), readyPrompt(state.target, issue, error), deps);
    try {
      const answer = parseReady(text);
      return { type: "ready", ready: answer.ready, reason: answer.reason };
    } catch (err) {
      error = (err as Error).message;
    }
  }
  return { type: "failed", code: "ready-check-invalid", reason: `the ready check did not return valid JSON (${error})` };
}

async function findProjectCommands(env: LoopEnv): Promise<LoopEvent> {
  const listing = await env.sandbox.exec("ls -A");
  const files = listing.stdout.split("\n").filter(Boolean);
  const commands = findCommands({
    agentsMd: await readIfExists(env.sandbox, "AGENTS.md"),
    packageJson: await readIfExists(env.sandbox, "package.json"),
    files,
  });
  return { type: "commands", setup: commands.setup, test: commands.test };
}

async function runLoopCommand(env: LoopEnv, command: string): Promise<{ ok: boolean; output: string; timedOut: boolean }> {
  const got = await env.sandbox.exec(command, { timeoutMs: env.commandTimeoutMs });
  const timedOut = got.hasTimedOut === true;
  return { ok: got.exitCode === 0 && !timedOut, output: `${got.stdout}${got.stderr}`, timedOut };
}

async function build(env: LoopEnv, state: LoopState): Promise<LoopEvent> {
  const changes = new ChangeTracker();
  const prompt = `Implement this GitHub issue in the repository in your workspace. Read the code first (read_file, search), then write the change and its tests with write_file and edit_file. You have no shell: the loop runs the tests afterwards with \`${state.commands?.test}\`, and they must pass. Change only what the issue asks for. Reply with a one-line summary when done.\n\n${issueText(state.target, state.issue!)}`;
  await runSubAgent(subAgent(env, "executor"), prompt, { fileTools: env.fileTools(changes), taskId: env.taskId, opts: env.subAgentOpts });
  const files = await changes.changedPaths(env.sandbox);
  return { type: "built", ok: files.length > 0, files };
}

async function pushChangedFiles(env: LoopEnv, state: LoopState): Promise<void> {
  const files = await Promise.all((state.changedFiles ?? []).map(async (path) => ({ path, content: await env.sandbox.readFile(path) })));
  const message = `${state.issue?.title ?? "Implement issue"} (#${state.target.number})`;
  await withGithub(env, (gh) => gh.pushFiles(state.target, state.branch!, files, message));
}

/** Does one action and says how it went. A throw is a failed event, so the run parks. */
async function perform(env: LoopEnv, state: LoopState, action: Action, hadPriorRun: boolean): Promise<LoopEvent> {
  const { target, branch, baseBranch } = state;
  switch (action.kind) {
    case "read": return readAndClone(env, state, hadPriorRun);
    case "ready-check": return readyCheck(env, state);
    case "commands": return findProjectCommands(env);
    case "setup": return { type: "setup", ...(await runLoopCommand(env, state.commands!.setup!)) };
    case "build": return build(env, state);
    case "test": {
      const got = await runLoopCommand(env, state.commands!.test);
      return { type: "tested", green: got.ok, output: got.output, timedOut: got.timedOut };
    }
    case "pr-branch":
      await withGithub(env, (gh) => gh.createBranch(target, branch!, baseBranch!));
      return { type: "branched" };
    case "pr-push":
      await pushChangedFiles(env, state);
      return { type: "pushed" };
    case "pr-open": {
      const title = state.issue?.title ?? `Implement #${target.number}`;
      const url = await withGithub(env, (gh) => gh.createPullRequest(target, { title, body: pullRequestBody(state, target), head: branch!, base: baseBranch! }));
      return { type: "opened", url };
    }
    default:
      return { type: "failed", code: "no-action", reason: `nothing to do for ${action.kind}` };
  }
}

/** One `loop-step` log line and one progress message: the step, the round and how it went. Never content. */
function report(env: LoopEnv, io: LoopIo, before: LoopState, after: LoopState): void {
  const result = after.step === "parked" ? (after.code ?? "parked") : "ok";
  log("loop-step", { taskId: env.taskId, step: before.step, round: before.round, result });
  io.progress({ type: "loop_step", step: before.step, round: before.round, result });
}

function parkedText(state: LoopState): string {
  return `Parked: ${state.reason ?? "the run stopped"}\nThe workspace and the run's state are kept.`;
}

/** Saves the state, then does actions until the run finishes, parks, or pauses for the start approval. */
async function drive(env: LoopEnv, io: LoopIo, session: SessionState, first: Next, hadPriorRun: boolean): Promise<void> {
  let current = first;
  for (;;) {
    const { state, action } = current;
    const pause = action.kind === "approve" ? startPause(env.taskId, action, state.target.number) : undefined;
    saveSession(env.dataDir, env.contextId, { ...session, loop: state, pending: pause });
    if (pause) return io.pause(pause);
    if (action.kind === "finish") return io.reply(state.prUrl ?? "");
    if (action.kind === "park" || action.kind === "noop") return io.reply(parkedText(state));
    if (env.signal.aborted) throw new Error("canceled");
    const event = await perform(env, state, action, hadPriorRun).catch((err: Error): LoopEvent => ({ type: "failed", code: "error", reason: `${state.step} failed: ${err.message}` }));
    current = next(state, event);
    report(env, io, state, current.state);
  }
}

/** The answer to the start approval: go on with the run, or keep it paused when the answer does not decide it. */
async function resumeApproval(env: LoopEnv, io: LoopIo, session: SessionState, pending: ToolApprovalPause, message: Message): Promise<void> {
  const state = session.loop!;
  const start = pending.tools[0]!;
  const answer = parseToolApprovalResponse(message)?.approvals;
  const decision = answer?.length === 1 && answer[0]!.id === start.id ? answer[0]!.decision : undefined;
  if (!decision) return io.pause(pending);
  const approved = decision.type !== "deny";
  const after = next(state, { type: "approval", approved, reason: decision.type === "deny" ? decision.reason : undefined });
  report(env, io, state, after.state);
  await drive(env, io, session, after, true);
}

export type LoopTurn = { env: LoopEnv; io: LoopIo; session: SessionState; text: string; message: Message };

/**
 * Handles a message if it belongs to the loop: the answer to the start approval, or an
 * /implement command. Returns false for an ordinary message, which the caller runs as a normal turn.
 */
export async function handleLoopMessage({ env, io, session, text, message }: LoopTurn): Promise<boolean> {
  const pending = session.pending?.taskId === env.taskId ? session.pending : undefined;
  if (session.loop?.step === "approve" && pending?.kind === "tool_approval" && pending.tools[0]?.name === START_TOOL) {
    await resumeApproval(env, io, session, pending, message);
    return true;
  }
  const command = parseImplementCommand(text);
  if (command.kind === "none") return false;
  if (command.kind === "invalid") {
    await io.reply(command.message);
    return true;
  }
  if (isOpen(session.loop)) {
    await io.reply(`A run is already open in this session (${session.loop!.target.owner}/${session.loop!.target.repo}#${session.loop!.target.number}, at step ${session.loop!.step}). Finish or answer it first.`);
    return true;
  }
  await drive(env, io, session, begin(command.target), session.loop !== undefined);
  return true;
}
