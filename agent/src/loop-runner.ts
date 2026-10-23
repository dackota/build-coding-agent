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
import { parseAskUserResponse, parseToolApprovalResponse } from "./hitl.ts";
import { type Action, type Axis, begin, canContinue, findingLines, isBlocking, isHeld, isTestFile, type Issue, type LoopEvent, type LoopState, type Next, next, parseImplementCommand, ROUND_CAP, reviewSchema, type Target } from "./loop.ts";
import { findCommands } from "./loop-commands.ts";
import { type Github, openGithub } from "./loop-github.ts";
import { log } from "./log.ts";
import { readIfExists, type Sandbox, shellQuote } from "./sandbox.ts";
import { type AskUserPause, saveSession, type SessionState, type ToolApprovalPause } from "./session-state.ts";
import type { StreamEvent } from "./stream-events.ts";
import { runSubAgent } from "./subagents.ts";
import { ChangeTracker } from "./workspace-diff.ts";
import type { McpBinding } from "./config.ts";

export const START_TOOL = "implement_start";
const START_CALL_ID = "implement-start";
const OUTPUT_TAIL_CHARS = 1500;
const MAX_CHANGED_FILES_IN_BODY = 20;
/** A subagent that must reply with JSON gets this many tries; each retry carries the last validation error. */
const JSON_ATTEMPTS = 2;

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
  /** Publishes the plan sign-off question (INPUT_REQUIRED); the runner has saved it. */
  ask(pause: AskUserPause): void;
  /** The run's reply: the task completes with this text. */
  reply(text: string): Promise<void>;
};

const PLAN_CALL_ID = "implement-plan";
const APPROVE = "approve";
const CHANGES = "changes";
const planAnswer = z.object({ tooBig: z.boolean(), reason: z.string().default(""), plan: z.string() });
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

function planPause(taskId: string, plan: string): AskUserPause {
  const question = `Here is the plan for this issue. Approve it, or send changes.\n\n${plan}\n\nChoose "${APPROVE}", or answer with your changes (for example "${CHANGES}: use a map").`;
  return { kind: "ask_user", taskId, requestId: randomUUID(), toolCallId: PLAN_CALL_ID, questions: [{ question, choices: [APPROVE, CHANGES], multiple: false }], messages: [] };
}

const issueText = (target: Target, issue: Issue): string =>
  `GitHub issue ${target.owner}/${target.repo}#${target.number}: ${issue.title}\n\n${issue.body}\n${issue.comments.length > 0 ? `\nComments:\n${issue.comments.map((c) => `- ${c}`).join("\n")}\n` : ""}`;

function readyPrompt(target: Target, issue: Issue, retry: string): string {
  return `Decide whether this GitHub issue is ready to build. It is ready when it says what to build and has testable acceptance criteria. You may read the repository (read_file, search) to check. Reply with only a JSON object: {"ready": true or false, "reason": "one sentence"}.${retry}\n\n${issueText(target, issue)}`;
}

function planPrompt(target: Target, issue: Issue, state: LoopState, retry: string): string {
  const revise = state.planChanges !== undefined && state.draftPlan ? `\n\nYour last plan was:\n${state.draftPlan}\n\nThe user asked for these changes. Write a new plan that makes them:\n${state.planChanges}` : "";
  const why = state.readyReason ? ` The issue is not ready to build: ${state.readyReason}.` : "";
  return `Plan the work for this GitHub issue in the repository in your workspace.${why} Read the code first (read_file, search). Write a plan for ONE ticket, one pull request: what to build, acceptance criteria that tests can check, the seams to test at, and a proof line (how to see it work). If the work is too big for one ticket, set tooBig to true. Reply with only a JSON object: {"tooBig": true or false, "reason": "one sentence", "plan": "the plan, as plain text"}.${revise}${retry}\n\n${issueText(target, issue)}`;
}

/** The JSON object in a reply (the first `{` to the last `}`), checked against the schema. */
function parseJsonReply<T>(text: string, schema: z.ZodType<T>): T {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end < start) throw new Error("no JSON object");
  return schema.parse(JSON.parse(text.slice(start, end + 1)));
}

const tail = (text: string): string => (text.length > OUTPUT_TAIL_CHARS ? `...${text.slice(-OUTPUT_TAIL_CHARS)}` : text);

function pullRequestBody(state: LoopState, target: Target): string {
  const test = state.commands?.test ?? "";
  const files = (state.changedFiles ?? []).slice(0, MAX_CHANGED_FILES_IN_BODY).map((f) => `- ${f}`).join("\n");
  const notes = (state.findings ?? []).filter((f) => !isBlocking(f));
  return [
    `Implements ${target.owner}/${target.repo}#${target.number} (https://github.com/${target.owner}/${target.repo}/issues/${target.number}).`,
    `Test result: \`${test}\` passed.\n\n\`\`\`\n${tail(state.testOutput ?? "").trim()}\n\`\`\``,
    `Changed files:\n${files}`,
    ...(notes.length > 0 ? [`Review findings (MEDIUM and LOW, not blocking):\n${findingLines(notes)}`] : []),
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

type JsonReply<T> = { ok: true; answer: T } | { ok: false; error: string };

/** The sentence a retry prompt ends with: empty on the first try, else the last validation error. */
const retryNote = (error: string | undefined): string => (error ? `\n\nYour last reply was not valid (${error}). Reply with only the JSON object.` : "");

/** Asks a read-only subagent for a JSON reply; invalid output is retried with the validation error. */
async function askJson<T>(env: LoopEnv, agent: string, schema: z.ZodType<T>, prompt: (retry: string) => string): Promise<JsonReply<T>> {
  const deps = { fileTools: env.fileTools(new ChangeTracker()), taskId: env.taskId, opts: env.subAgentOpts };
  let error: string | undefined;
  for (let attempt = 0; attempt < JSON_ATTEMPTS; attempt++) {
    const text = await runSubAgent(subAgent(env, agent), prompt(retryNote(error)), deps);
    try {
      return { ok: true, answer: parseJsonReply(text, schema) };
    } catch (err) {
      error = (err as Error).message;
    }
  }
  return { ok: false, error: error ?? "no reply" };
}

async function readyCheck(env: LoopEnv, state: LoopState): Promise<LoopEvent> {
  const got = await askJson(env, "explorer", readyAnswer, (retry) => readyPrompt(state.target, state.issue!, retry));
  if (!got.ok) return { type: "failed", code: "ready-check-invalid", reason: `the ready check did not return valid JSON (${got.error})` };
  return { type: "ready", ready: got.answer.ready, reason: got.answer.reason };
}

async function planStep(env: LoopEnv, state: LoopState): Promise<LoopEvent> {
  const got = await askJson(env, "explorer", planAnswer, (retry) => planPrompt(state.target, state.issue!, state, retry));
  if (!got.ok) return { type: "failed", code: "plan-invalid", reason: `the plan step did not return valid JSON (${got.error})` };
  return { type: "planned", plan: got.answer.plan, tooBig: got.answer.tooBig, reason: got.answer.reason };
}

async function findProjectCommands(env: LoopEnv, state: LoopState): Promise<LoopEvent> {
  const listing = await env.sandbox.exec("ls -A");
  const files = listing.stdout.split("\n").filter(Boolean);
  const commands = findCommands({
    plan: state.plan,
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

/** What every executor prompt carries: the issue, the user's note, the last findings and the last test output. */
function context(state: LoopState): string {
  const parts = [issueText(state.target, state.issue!)];
  if (state.plan) parts.push(`Approved plan:\n${state.plan}`);
  if (state.note) parts.push(`Note from the user: ${state.note}`);
  if (state.feedback) parts.push(state.feedback);
  if (state.testOutput) parts.push(`Last test output:\n${tail(state.testOutput)}`);
  return parts.join("\n\n");
}

const TESTS_PROMPT = (test: string | undefined) =>
  `Write ONLY the tests for this GitHub issue in the repository in your workspace: new test files, and no other file. Read the code first (read_file, search). Do not write the feature. You have no shell: the loop runs the tests afterwards with \`${test}\`, and they must fail now because the feature is missing. Reply with a one-line summary when done.`;
const CODE_PROMPT = (test: string | undefined) =>
  `The tests for this GitHub issue are written and fail. Write the code that makes them pass. Read the tests and the code first (read_file, search). Do not weaken the tests. You have no shell: the loop runs the tests afterwards with \`${test}\`, and they must pass. Reply with a one-line summary when done.`;

/** Removes what the executor wrote that the step did not allow: restores a tracked file, deletes a new one. */
async function revert(env: LoopEnv, paths: readonly string[]): Promise<void> {
  for (const path of paths) await env.sandbox.exec(`git checkout -- ${shellQuote(path)} 2>/dev/null || rm -f -- ${shellQuote(path)}`);
}

async function build(env: LoopEnv, state: LoopState, kind: "tests" | "code"): Promise<LoopEvent> {
  const changes = new ChangeTracker();
  const prompt = `${kind === "tests" ? TESTS_PROMPT(state.commands?.test) : CODE_PROMPT(state.commands?.test)}\n\n${context(state)}`;
  await runSubAgent(subAgent(env, "executor"), prompt, { fileTools: env.fileTools(changes), taskId: env.taskId, opts: env.subAgentOpts });
  const files = await changes.changedPaths(env.sandbox);
  if (kind === "tests") await revert(env, files.filter((f) => !isTestFile(f)));
  return { type: "built", ok: true, files };
}

const MAX_DIFF_CHARS = 12000;
const SPEC_QUESTION = "Does the change do what the issue asks? Check every requirement and acceptance criterion in the issue against the diff and the code. A missing or wrong behaviour is a finding.";
const STANDARDS_QUESTION = "Does the change follow this repository's coding standards? Read AGENTS.md (read_file) and check the diff against each rule it states. If there is no AGENTS.md, only report clear defects of style or structure.";

/** The diff of the files the build changed against the clone's HEAD, capped; new files show in full. */
async function changeDiff(env: LoopEnv, files: readonly string[]): Promise<string> {
  if (files.length === 0) return "";
  const paths = files.map(shellQuote).join(" ");
  const got = await env.sandbox.exec(`git add -N -- ${paths} && git diff HEAD -- ${paths}`);
  const diff = got.stdout;
  return diff.length > MAX_DIFF_CHARS ? `${diff.slice(0, MAX_DIFF_CHARS)}\n... (diff cut; read the files for the rest)` : diff;
}

function reviewPrompt(axis: Axis, state: LoopState, diff: string, retry: string): string {
  return `You are reviewing a change to the repository in your workspace. ${axis === "spec" ? SPEC_QUESTION : STANDARDS_QUESTION} You may read the repository (read_file, search); you cannot change it. Reply with only a JSON object: {"findings": [{"severity": "CRITICAL" | "HIGH" | "MEDIUM" | "LOW", "file": "path", "reason": "one sentence"}]}. Use CRITICAL or HIGH only for a problem that must be fixed before the change merges. An empty list means no findings.${retry}\n\n${issueText(state.target, state.issue!)}${state.plan ? `\nApproved plan (the user signed this off; the spec review checks the diff against it too):\n${state.plan}\n` : ""}\nFiles changed: ${(state.changedFiles ?? []).join(", ")}\n\nDiff:\n${diff}`;
}

/** One fresh reviewer call; invalid output gets one retry with the validation error. */
async function review(env: LoopEnv, state: LoopState, axis: Axis): Promise<LoopEvent> {
  const diff = await changeDiff(env, state.changedFiles ?? []);
  const got = await askJson(env, "reviewer", reviewSchema, (retry) => reviewPrompt(axis, state, diff, retry));
  if (!got.ok) return { type: "failed", code: "review-invalid", reason: `the ${axis} review did not return valid JSON findings (${got.error})` };
  return { type: "reviewed", findings: got.answer.findings };
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
    case "plan": return planStep(env, state);
    case "commands": return findProjectCommands(env, state);
    case "setup": return { type: "setup", ...(await runLoopCommand(env, state.commands!.setup!)) };
    case "build-tests": return build(env, state, "tests");
    case "build-code": return build(env, state, "code");
    case "test": {
      const got = await runLoopCommand(env, state.commands!.test);
      return { type: "tested", green: got.ok, output: got.output, timedOut: got.timedOut };
    }
    case "review": return review(env, state, action.axis);
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
  const output = state.testOutput ? `\n\nLast test output:\n${tail(state.testOutput)}` : "";
  const open = (state.findings ?? []).filter(isBlocking);
  const findings = open.length > 0 ? `\n\nOpen findings:\n${findingLines(open)}` : "";
  const nextHint = canContinue(state) ? `\nSend /implement continue [note] for ${ROUND_CAP} more rounds, or /implement stop to drop the run.` : "\nSend /implement stop to drop the run.";
  return `Parked: ${state.reason ?? "the run stopped"}${output}${findings}\nThe workspace and the run's state are kept.${nextHint}`;
}

/** Saves the state, then does actions until the run finishes, parks, or pauses for the start approval. */
async function drive(env: LoopEnv, io: LoopIo, session: SessionState, first: Next, hadPriorRun: boolean): Promise<void> {
  let current = first;
  for (;;) {
    const { state, action } = current;
    const pause = action.kind === "approve" ? startPause(env.taskId, action, state.target.number) : action.kind === "signoff" ? planPause(env.taskId, action.plan) : undefined;
    saveSession(env.dataDir, env.contextId, { ...session, loop: state, pending: pause });
    if (pause?.kind === "tool_approval") return io.pause(pause);
    if (pause) return io.ask(pause);
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

/** The answer to the plan pause: approve, or changes (text after an optional "changes:" prefix). Undefined when it decides nothing. */
export function readPlanAnswer(answers: string[][]): { approved: boolean; changes?: string } | undefined {
  const text = (answers[0] ?? []).join(" ").trim();
  if (text === "") return undefined;
  if (text.toLowerCase() === APPROVE) return { approved: true };
  const changes = text.replace(/^changes\s*:?\s*/i, "").trim();
  return { approved: false, changes: changes === "" ? text : changes };
}

/** The answer to the plan pause: go on with the run, or keep it paused when the answer does not decide it. */
async function resumePlan(env: LoopEnv, io: LoopIo, session: SessionState, pending: AskUserPause, message: Message): Promise<void> {
  const state = session.loop!;
  const answer = parseAskUserResponse(message);
  const decision = answer && answer.id === pending.requestId ? readPlanAnswer(answer.answers) : undefined;
  if (!decision) return io.ask(pending);
  const after = next(state, { type: "signoff", ...decision });
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
  if (session.loop?.step === "plan-signoff" && pending?.kind === "ask_user" && pending.toolCallId === PLAN_CALL_ID) {
    await resumePlan(env, io, session, pending, message);
    return true;
  }
  const command = parseImplementCommand(text);
  if (command.kind === "none") return false;
  if (command.kind === "invalid") {
    await io.reply(command.message);
    return true;
  }
  const loop = session.loop;
  if (command.kind === "stop") return stopRun(env, io, session);
  if (command.kind === "continue") {
    if (!loop || !canContinue(loop)) {
      await io.reply("There is no parked run to continue in this session.");
      return true;
    }
    const after = next(loop, { type: "continue", note: command.note });
    report(env, io, loop, after.state);
    await drive(env, io, session, after, true);
    return true;
  }
  if (isHeld(loop)) {
    const where = loop!.step === "parked" ? "parked" : `at step ${loop!.step}`;
    await io.reply(`A run is already open in this session (${loop!.target.owner}/${loop!.target.repo}#${loop!.target.number}, ${where}). Finish or answer it first${loop!.step === "parked" ? ", or send /implement continue [note] or /implement stop" : ""}.`);
    return true;
  }
  await drive(env, io, session, begin(command.target), loop !== undefined);
  return true;
}

/** `/implement stop`: the run is dropped, its workspace is cleared by the next run. */
async function stopRun(env: LoopEnv, io: LoopIo, session: SessionState): Promise<boolean> {
  const loop = session.loop;
  if (!isHeld(loop)) {
    await io.reply("There is no run to stop in this session.");
    return true;
  }
  const after = next(loop!, { type: "stop" });
  report(env, io, loop!, after.state);
  saveSession(env.dataDir, env.contextId, { ...session, loop: after.state, pending: undefined });
  await io.reply("Stopped the run. Send /implement <issue URL> to start a new one.");
  return true;
}
