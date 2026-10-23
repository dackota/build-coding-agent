// The implement loop's step machine: pure, no I/O. next(state, event) gives the new state and the
// one action the runner does next; the runner does it and feeds the result back as an event.
// An event the current step does not expect parks the run, so a step cannot be skipped or
// repeated and no sequence of events can throw.
import { z } from "zod";

export const STEPS = ["read", "ready-check", "plan", "plan-signoff", "commands", "approve", "setup", "build-tests", "check-red", "build-code", "check-green", "review-spec", "review-standards", "pr", "done", "parked", "stopped"] as const;
export type Step = (typeof STEPS)[number];

export const SEVERITIES = ["CRITICAL", "HIGH", "MEDIUM", "LOW"] as const;
export const findingSchema = z.object({ severity: z.enum(SEVERITIES), file: z.string(), reason: z.string() });
/** One review finding: how serious, which file, and why. */
export type Finding = z.infer<typeof findingSchema>;
/** What a reviewer must return. */
export const reviewSchema = z.object({ findings: z.array(findingSchema) });
/** The two review axes, one fresh reviewer call each per round. */
export type Axis = "spec" | "standards";

export type Target = { owner: string; repo: string; number: number };
export type Issue = { title: string; body: string; comments: string[] };

const MAX_OUTPUT_CHARS = 4000;
const MAX_SLUG_CHARS = 40;
const MAX_FINDINGS = 50;
const MAX_FINDING_CHARS = 500;
const MAX_BRANCH_FILES = 200;
/** Build, check and review share one round counter with this cap; `continue` adds this many rounds. */
export const ROUND_CAP = 3;

const targetSchema = z.object({ owner: z.string(), repo: z.string(), number: z.number().int() });
const issueSchema = z.object({ title: z.string(), body: z.string(), comments: z.array(z.string()) });

export const loopStateSchema = z.object({
  step: z.enum(STEPS),
  /** Build and check share this counter, 1-based, never past `cap`. */
  round: z.number().int(),
  cap: z.number().int().default(ROUND_CAP),
  /** The approved plan: one ticket, with acceptance criteria, seams and a proof line. Set only after sign-off. */
  plan: z.string().optional(),
  /** Why the ready check failed, for the plan prompt. */
  readyReason: z.string().optional(),
  /** The plan under review at the sign-off, and the user's last "changes" text for the next plan. */
  draftPlan: z.string().optional(),
  planChanges: z.string().optional(),
  /** How many times the user answered the plan pause with changes. */
  planRevisions: z.number().int().default(0),
  /** What the next executor prompt must say: why the last step went back. */
  feedback: z.string().optional(),
  /** The user's note from `/implement continue <note>`, for every executor prompt after it. */
  note: z.string().optional(),
  /** Where a parked run goes on from on `continue`; absent when it cannot continue. */
  resume: z.enum(["build-tests", "build-code"]).optional(),
  /** Where the run goes after the setup it is in (setup runs again when a lockfile changed). */
  afterSetup: z.enum(["check-green"]).optional(),
  target: targetSchema,
  issue: issueSchema.optional(),
  baseBranch: z.string().optional(),
  /** The commands the user approved: fixed for the run. */
  commands: z.object({ setup: z.string().optional(), test: z.string() }).optional(),
  branch: z.string().optional(),
  /** The files the build changed, workspace-relative. */
  changedFiles: z.array(z.string()).optional(),
  /** The findings of the last review (both axes); the CRITICAL and HIGH ones block the pull request. */
  findings: z.array(findingSchema).optional(),
  /** The last test run: whether it was green, and its output (capped). */
  testGreen: z.boolean().optional(),
  testOutput: z.string().optional(),
  prStage: z.number().int(),
  prUrl: z.string().optional(),
  /** Why the run parked, for the user; and a short code for the log. */
  reason: z.string().optional(),
  code: z.string().optional(),
});
export type LoopState = z.infer<typeof loopStateSchema>;

export type LoopEvent =
  | { type: "read"; issue: Issue; baseBranch: string }
  | { type: "ready"; ready: boolean; reason: string }
  | { type: "planned"; plan: string; tooBig: boolean; reason?: string | undefined }
  | { type: "signoff"; approved: boolean; changes?: string | undefined }
  | { type: "commands"; setup: string | undefined; test: string | undefined }
  | { type: "approval"; approved: boolean; reason?: string | undefined }
  | { type: "setup"; ok: boolean; output: string; timedOut?: boolean | undefined }
  | { type: "built"; ok: boolean; files: string[] }
  | { type: "tested"; green: boolean; output: string; timedOut?: boolean | undefined }
  | { type: "reviewed"; findings: Finding[] }
  | { type: "branched" }
  | { type: "pushed" }
  | { type: "opened"; url: string }
  | { type: "continue"; note?: string | undefined }
  | { type: "stop" }
  | { type: "failed"; code: string; reason: string };

export type Action =
  | { kind: "read" }
  | { kind: "ready-check" }
  | { kind: "plan" }
  | { kind: "signoff"; plan: string }
  | { kind: "commands" }
  | { kind: "approve"; setup: string | undefined; test: string; branch: string; repo: string }
  | { kind: "setup" }
  | { kind: "build-tests" }
  | { kind: "build-code" }
  | { kind: "test" }
  | { kind: "review"; axis: Axis }
  | { kind: "pr-branch" }
  | { kind: "pr-push" }
  | { kind: "pr-open" }
  | { kind: "finish" }
  | { kind: "park" }
  | { kind: "noop" };

export type Next = { state: LoopState; action: Action };

const ISSUE_URL = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/issues\/(\d{1,9})\/?$/;
const USAGE = "usage: /implement https://github.com/<owner>/<repo>/issues/<n>";

export type ImplementCommand =
  | { kind: "none" }
  | { kind: "start"; target: Target }
  | { kind: "continue"; note?: string }
  | { kind: "stop" }
  | { kind: "invalid"; message: string };

/** What a message asks of the loop: nothing (an ordinary turn), a run on an issue, continue, stop, or a usage error. */
export function parseImplementCommand(text: string): ImplementCommand {
  const match = /^\s*\/implement(?:\s+(.*?))?\s*$/s.exec(text);
  if (!match) return { kind: "none" };
  if (match[1] === "stop") return { kind: "stop" };
  const resume = /^continue(?:\s+(.*))?$/s.exec(match[1] ?? "");
  if (resume) return resume[1] ? { kind: "continue", note: resume[1] } : { kind: "continue" };
  const url = ISSUE_URL.exec(match[1] ?? "");
  const isDotName = (name: string | undefined) => name === "." || name === "..";
  if (!url || isDotName(url[1]) || isDotName(url[2])) return { kind: "invalid", message: `Cannot start: ${USAGE}` };
  return { kind: "start", target: { owner: url[1]!, repo: url[2]!, number: Number(url[3]) } };
}

/** implement/<issue number>-<short slug of the title>. */
export function branchName(number: number, title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_SLUG_CHARS)
    .replace(/-+$/, "");
  return `implement/${number}-${slug || "issue"}`;
}

const TEST_DIRS = new Set(["test", "tests", "__tests__"]);
const LOCKFILES = new Set(["package-lock.json", "pnpm-lock.yaml", "yarn.lock", "bun.lockb", "go.sum", "Cargo.lock", "poetry.lock", "uv.lock", "Gemfile.lock", "composer.lock"]);

/** A test file by its path: under test/, tests/ or __tests__/, or named *.test.*, *.spec.*, *_test.* or test_*.py. */
export function isTestFile(path: string): boolean {
  const parts = path.split("/");
  const name = parts.at(-1) ?? "";
  return parts.slice(0, -1).some((dir) => TEST_DIRS.has(dir)) || /\.(test|spec)\.[^.]+$/.test(name) || /_test\.[^.]+$/.test(name) || /^test_.+\.py$/.test(name);
}

/** A dependency lockfile by its name. */
export const isLockfile = (path: string): boolean => LOCKFILES.has(path.split("/").at(-1) ?? "");

/** A finding that stops the pull request. */
export const isBlocking = (finding: Finding): boolean => finding.severity === "CRITICAL" || finding.severity === "HIGH";

/** The findings as lines for a prompt, a reply or a pull request body: `- [HIGH] file: reason`. */
export function findingLines(findings: readonly Finding[]): string {
  return findings.map((f) => `- [${f.severity}] ${f.file}: ${f.reason}`).join("\n");
}

const boundFindings = (findings: readonly Finding[]): Finding[] =>
  findings.slice(0, MAX_FINDINGS).map((f) => ({ severity: f.severity, file: f.file.slice(0, MAX_FINDING_CHARS), reason: f.reason.slice(0, MAX_FINDING_CHARS) }));

/** A parked run that stopped in the build, check or review can go on with more rounds. */
export const canContinue = (state: LoopState): boolean => state.step === "parked" && state.resume !== undefined;

const capped = (text: string): string => (text.length > MAX_OUTPUT_CHARS ? text.slice(-MAX_OUTPUT_CHARS) : text);

/** The action a state is waiting on. Saved and loaded, a state gives the same action. */
export function actionFor(state: LoopState): Action {
  switch (state.step) {
    case "read": return { kind: "read" };
    case "ready-check": return { kind: "ready-check" };
    case "plan": return { kind: "plan" };
    case "plan-signoff": return { kind: "signoff", plan: state.draftPlan ?? "" };
    case "commands": return { kind: "commands" };
    case "approve":
      return { kind: "approve", setup: state.commands?.setup, test: state.commands?.test ?? "", branch: state.branch ?? "", repo: `${state.target.owner}/${state.target.repo}` };
    case "setup": return { kind: "setup" };
    case "build-tests": return { kind: "build-tests" };
    case "build-code": return { kind: "build-code" };
    case "check-red":
    case "check-green": return { kind: "test" };
    case "review-spec": return { kind: "review", axis: "spec" };
    case "review-standards": return { kind: "review", axis: "standards" };
    case "pr": return { kind: (["pr-branch", "pr-push", "pr-open"] as const)[Math.min(state.prStage, 2)]! };
    case "done": return { kind: "finish" };
    case "parked": return { kind: "park" };
    case "stopped": return { kind: "noop" };
  }
}

const result = (state: LoopState): Next => ({ state, action: actionFor(state) });
const move = (state: LoopState, step: Step, patch: Partial<LoopState> = {}): Next => result({ ...state, ...patch, step });
const park = (state: LoopState, code: string, reason: string): Next => result({ ...state, step: "parked", code, reason });

/** A run on `target`, at its first step. */
export function begin(target: Target): Next {
  return result({ step: "read", round: 1, cap: ROUND_CAP, target, prStage: 0, planRevisions: 0 });
}

/** True while a run is still going: not finished, parked or stopped. */
export const isOpen = (state: LoopState | undefined): boolean => state !== undefined && !["done", "parked", "stopped"].includes(state.step);

/** True while a run holds the session: going or parked. A new run starts only when this is false. */
export const isHeld = (state: LoopState | undefined): boolean => isOpen(state) || state?.step === "parked";

const TOO_EARLY = "Your tests passed before any code was written, so they test nothing new. Write a test that will fail for the right reason.";
const STILL_RED = "The tests still fail after your code. Fix the code so they pass.";

/** The next round at `step`, or a park that `continue` can resume when the round cap is reached. */
function nextRound(state: LoopState, step: "build-tests" | "build-code", patch: Partial<LoopState>, why: string): Next {
  if (state.round >= state.cap) return result({ ...state, ...patch, step: "parked", code: "rounds", reason: `stopped after ${state.cap} rounds: ${why}`, resume: step });
  return move(state, step, { ...patch, round: state.round + 1 });
}

function afterCheck(state: LoopState, event: Extract<LoopEvent, { type: "tested" }>): Next {
  const output = capped(event.output);
  if (event.timedOut) return park(state, "timeout", "the test command timed out");
  if (state.step === "check-red") {
    if (!event.green) return move(state, "build-code", { testGreen: false, testOutput: output, feedback: undefined });
    return nextRound(state, "build-tests", { testGreen: true, testOutput: output, feedback: TOO_EARLY }, "the tests passed before any code was written");
  }
  if (event.green) return move(state, "review-spec", { testGreen: true, testOutput: output, feedback: undefined, findings: [] });
  return nextRound(state, "build-code", { testGreen: false, testOutput: output, feedback: STILL_RED }, "the tests still fail");
}

const union = (a: readonly string[] | undefined, b: readonly string[]): string[] => [...new Set([...(a ?? []), ...b])].sort().slice(0, MAX_BRANCH_FILES);

/** The executor wrote the tests: only test files are allowed, else the round is a protocol error. */
function afterTestsWritten(state: LoopState, event: Extract<LoopEvent, { type: "built" }>): Next {
  if (!event.ok) return park(state, "build-failed", "the executor step failed");
  const others = event.files.filter((f) => !isTestFile(f));
  if (event.files.length === 0 || others.length > 0) {
    const feedback = others.length > 0
      ? `Protocol error: this step may write only test files, but you also wrote ${others.join(", ")}. Those files were removed. Write only the tests.`
      : "Protocol error: you wrote no test file. Write the tests.";
    return nextRound(state, "build-tests", { feedback }, "the executor did not write only tests");
  }
  return move(state, "check-red", { changedFiles: union(state.changedFiles, event.files), testGreen: undefined, feedback: undefined });
}

/** The executor wrote the code: setup runs again first when a lockfile changed and a setup command was approved. */
function afterCodeWritten(state: LoopState, event: Extract<LoopEvent, { type: "built" }>): Next {
  if (!event.ok) return park(state, "build-failed", "the executor step failed");
  const patch = { changedFiles: union(state.changedFiles, event.files), testGreen: undefined, feedback: undefined };
  if (state.commands?.setup && event.files.some(isLockfile)) return move(state, "setup", { ...patch, afterSetup: "check-green" });
  return move(state, "check-green", patch);
}

/** The spec review is in: keep its findings and run the standards review. The standards review decides the next step. */
function afterReview(state: LoopState, event: Extract<LoopEvent, { type: "reviewed" }>): Next {
  const found = [...(state.findings ?? []), ...boundFindings(event.findings)].slice(0, MAX_FINDINGS);
  if (state.step === "review-spec") return move(state, "review-standards", { findings: found });
  const blocking = found.filter(isBlocking);
  if (blocking.length === 0) return move(state, "pr", { findings: found, prStage: 0, feedback: undefined });
  const feedback = `A review found problems to fix in your code. Fix each CRITICAL and HIGH finding:\n${findingLines(blocking)}`;
  return nextRound(state, "build-code", { findings: found, feedback }, "the review still has CRITICAL or HIGH findings");
}

function afterContinue(state: LoopState, event: Extract<LoopEvent, { type: "continue" }>): Next {
  if (!state.resume) return result(state);
  return move(state, state.resume, { round: state.round + 1, cap: state.cap + ROUND_CAP, note: event.note ?? state.note, resume: undefined, code: undefined, reason: undefined });
}

function afterApproval(state: LoopState, event: Extract<LoopEvent, { type: "approval" }>): Next {
  if (!event.approved) return park(state, "denied", `the start approval was denied${event.reason ? `: ${event.reason}` : "."}`);
  return state.commands?.setup ? move(state, "setup") : move(state, "build-tests");
}

/** Changes the user may ask for before the run parks: the third "changes" answer parks. */
export const MAX_PLAN_REVISIONS = 2;

function afterPlanned(state: LoopState, event: Extract<LoopEvent, { type: "planned" }>): Next {
  if (event.tooBig) return park(state, "plan-too-big", `split this issue: the plan is too big for one ticket${event.reason ? ` (${event.reason})` : ""}`);
  return move(state, "plan-signoff", { draftPlan: event.plan });
}

function afterSignoff(state: LoopState, event: Extract<LoopEvent, { type: "signoff" }>): Next {
  if (event.approved) return move(state, "commands", { plan: state.draftPlan, planChanges: undefined });
  if (state.planRevisions >= MAX_PLAN_REVISIONS) return park(state, "plan-changes", `the plan was sent back for changes ${MAX_PLAN_REVISIONS + 1} times; no plan was approved`);
  return move(state, "plan", { planRevisions: state.planRevisions + 1, planChanges: event.changes ?? "" });
}

function afterCommands(state: LoopState, event: Extract<LoopEvent, { type: "commands" }>): Next {
  if (!event.test) return park(state, "no-test-command", "no test command found (AGENTS.md or package.json); the loop never builds with no gate");
  const branch = branchName(state.target.number, state.issue?.title ?? "");
  return move(state, "approve", { commands: { setup: event.setup, test: event.test }, branch });
}

/** The next state and action for an event. An event the step does not expect, or a runner failure, parks the run. */
export function next(state: LoopState, event: LoopEvent): Next {
  if (event.type === "stop") return state.step === "done" ? result(state) : move(state, "stopped");
  if (state.step === "parked") return event.type === "continue" ? afterContinue(state, event) : result(state);
  if (state.step === "done" || state.step === "stopped") return result(state);
  if (event.type === "failed") return park(state, event.code, event.reason);
  if (state.step === "read" && event.type === "read") return move(state, "ready-check", { issue: event.issue, baseBranch: event.baseBranch });
  if (state.step === "ready-check" && event.type === "ready") {
    return event.ready ? move(state, "commands") : move(state, "plan", { readyReason: event.reason });
  }
  if (state.step === "plan" && event.type === "planned") return afterPlanned(state, event);
  if (state.step === "plan-signoff" && event.type === "signoff") return afterSignoff(state, event);
  if (state.step === "commands" && event.type === "commands") return afterCommands(state, event);
  if (state.step === "approve" && event.type === "approval") return afterApproval(state, event);
  if (state.step === "setup" && event.type === "setup") {
    if (event.timedOut) return park(state, "timeout", "the setup command timed out");
    return event.ok ? move(state, state.afterSetup ?? "build-tests", { afterSetup: undefined }) : park(state, "setup-failed", `the setup command failed:\n${capped(event.output)}`);
  }
  if (state.step === "build-tests" && event.type === "built") return afterTestsWritten(state, event);
  if (state.step === "build-code" && event.type === "built") return afterCodeWritten(state, event);
  if ((state.step === "check-red" || state.step === "check-green") && event.type === "tested") return afterCheck(state, event);
  if ((state.step === "review-spec" || state.step === "review-standards") && event.type === "reviewed") return afterReview(state, event);
  if (state.step === "pr" && state.prStage === 0 && event.type === "branched") return move(state, "pr", { prStage: 1 });
  if (state.step === "pr" && state.prStage === 1 && event.type === "pushed") return move(state, "pr", { prStage: 2 });
  if (state.step === "pr" && state.prStage >= 2 && event.type === "opened") return move(state, "done", { prUrl: event.url });
  return park(state, "unexpected-event", `the run reached an unexpected state (${event.type} during ${state.step})`);
}
