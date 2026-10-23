// The implement loop's step machine: pure, no I/O. next(state, event) gives the new state and the
// one action the runner does next; the runner does it and feeds the result back as an event.
// An event the current step does not expect parks the run, so a step cannot be skipped or
// repeated and no sequence of events can throw.
import { z } from "zod";

export const STEPS = ["read", "ready-check", "commands", "approve", "setup", "build", "check", "pr", "done", "parked"] as const;
export type Step = (typeof STEPS)[number];

export type Target = { owner: string; repo: string; number: number };
export type Issue = { title: string; body: string; comments: string[] };

const MAX_OUTPUT_CHARS = 4000;
const MAX_SLUG_CHARS = 40;
const MAX_BRANCH_FILES = 200;

const targetSchema = z.object({ owner: z.string(), repo: z.string(), number: z.number().int() });
const issueSchema = z.object({ title: z.string(), body: z.string(), comments: z.array(z.string()) });

export const loopStateSchema = z.object({
  step: z.enum(STEPS),
  /** Build, check and review share this counter (the cap is ticket 02). */
  round: z.number().int(),
  target: targetSchema,
  issue: issueSchema.optional(),
  baseBranch: z.string().optional(),
  /** The commands the user approved: fixed for the run. */
  commands: z.object({ setup: z.string().optional(), test: z.string() }).optional(),
  branch: z.string().optional(),
  /** The files the build changed, workspace-relative. */
  changedFiles: z.array(z.string()).optional(),
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
  | { type: "commands"; setup: string | undefined; test: string | undefined }
  | { type: "approval"; approved: boolean; reason?: string | undefined }
  | { type: "setup"; ok: boolean; output: string; timedOut?: boolean | undefined }
  | { type: "built"; ok: boolean; files: string[] }
  | { type: "tested"; green: boolean; output: string; timedOut?: boolean | undefined }
  | { type: "branched" }
  | { type: "pushed" }
  | { type: "opened"; url: string }
  | { type: "failed"; code: string; reason: string };

export type Action =
  | { kind: "read" }
  | { kind: "ready-check" }
  | { kind: "commands" }
  | { kind: "approve"; setup: string | undefined; test: string; branch: string; repo: string }
  | { kind: "setup" }
  | { kind: "build" }
  | { kind: "test" }
  | { kind: "pr-branch" }
  | { kind: "pr-push" }
  | { kind: "pr-open" }
  | { kind: "finish" }
  | { kind: "park" }
  | { kind: "noop" };

export type Next = { state: LoopState; action: Action };

const ISSUE_URL = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/issues\/(\d{1,9})\/?$/;
const USAGE = "usage: /implement https://github.com/<owner>/<repo>/issues/<n>";

export type ImplementCommand = { kind: "none" } | { kind: "start"; target: Target } | { kind: "invalid"; message: string };

/** What a message asks of the loop: nothing (an ordinary turn), a run on an issue, or a usage error. */
export function parseImplementCommand(text: string): ImplementCommand {
  const match = /^\s*\/implement(?:\s+(.*?))?\s*$/s.exec(text);
  if (!match) return { kind: "none" };
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

const capped = (text: string): string => (text.length > MAX_OUTPUT_CHARS ? text.slice(-MAX_OUTPUT_CHARS) : text);

/** The action a state is waiting on. Saved and loaded, a state gives the same action. */
export function actionFor(state: LoopState): Action {
  switch (state.step) {
    case "read": return { kind: "read" };
    case "ready-check": return { kind: "ready-check" };
    case "commands": return { kind: "commands" };
    case "approve":
      return { kind: "approve", setup: state.commands?.setup, test: state.commands?.test ?? "", branch: state.branch ?? "", repo: `${state.target.owner}/${state.target.repo}` };
    case "setup": return { kind: "setup" };
    case "build": return { kind: "build" };
    case "check": return { kind: "test" };
    case "pr": return { kind: (["pr-branch", "pr-push", "pr-open"] as const)[Math.min(state.prStage, 2)]! };
    case "done": return { kind: "finish" };
    case "parked": return { kind: "park" };
  }
}

const result = (state: LoopState): Next => ({ state, action: actionFor(state) });
const move = (state: LoopState, step: Step, patch: Partial<LoopState> = {}): Next => result({ ...state, ...patch, step });
const park = (state: LoopState, code: string, reason: string): Next => result({ ...state, step: "parked", code, reason });

/** A run on `target`, at its first step. */
export function begin(target: Target): Next {
  return result({ step: "read", round: 1, target, prStage: 0 });
}

/** True while a run is still going: not finished, not parked. */
export const isOpen = (state: LoopState | undefined): boolean => state !== undefined && state.step !== "done" && state.step !== "parked";

function afterCheck(state: LoopState, event: Extract<LoopEvent, { type: "tested" }>): Next {
  const output = capped(event.output);
  if (event.timedOut) return park(state, "timeout", "the test command timed out");
  if (!event.green) return park({ ...state, testGreen: false, testOutput: output }, "red", `the tests failed:\n${output}`);
  return move(state, "pr", { testGreen: true, testOutput: output, prStage: 0 });
}

function afterApproval(state: LoopState, event: Extract<LoopEvent, { type: "approval" }>): Next {
  if (!event.approved) return park(state, "denied", `the start approval was denied${event.reason ? `: ${event.reason}` : "."}`);
  return state.commands?.setup ? move(state, "setup") : move(state, "build");
}

function afterCommands(state: LoopState, event: Extract<LoopEvent, { type: "commands" }>): Next {
  if (!event.test) return park(state, "no-test-command", "no test command found (AGENTS.md or package.json); the loop never builds with no gate");
  const branch = branchName(state.target.number, state.issue?.title ?? "");
  return move(state, "approve", { commands: { setup: event.setup, test: event.test }, branch });
}

/** The next state and action for an event. An event the step does not expect, or a runner failure, parks the run. */
export function next(state: LoopState, event: LoopEvent): Next {
  if (state.step === "done" || state.step === "parked") return result(state);
  if (event.type === "failed") return park(state, event.code, event.reason);
  if (state.step === "read" && event.type === "read") return move(state, "ready-check", { issue: event.issue, baseBranch: event.baseBranch });
  if (state.step === "ready-check" && event.type === "ready") {
    return event.ready ? move(state, "commands") : park(state, "not-ready", `the issue is not ready to build: ${event.reason}`);
  }
  if (state.step === "commands" && event.type === "commands") return afterCommands(state, event);
  if (state.step === "approve" && event.type === "approval") return afterApproval(state, event);
  if (state.step === "setup" && event.type === "setup") {
    if (event.timedOut) return park(state, "timeout", "the setup command timed out");
    return event.ok ? move(state, "build") : park(state, "setup-failed", `the setup command failed:\n${capped(event.output)}`);
  }
  if (state.step === "build" && event.type === "built") {
    if (!event.ok || event.files.length === 0) return park(state, "build-failed", "the executor changed no files");
    return move(state, "check", { changedFiles: event.files.slice(0, MAX_BRANCH_FILES), testGreen: undefined });
  }
  if (state.step === "check" && event.type === "tested") return afterCheck(state, event);
  if (state.step === "pr" && state.prStage === 0 && event.type === "branched") return move(state, "pr", { prStage: 1 });
  if (state.step === "pr" && state.prStage === 1 && event.type === "pushed") return move(state, "pr", { prStage: 2 });
  if (state.step === "pr" && state.prStage >= 2 && event.type === "opened") return move(state, "done", { prUrl: event.url });
  return park(state, "unexpected-event", `the run reached an unexpected state (${event.type} during ${state.step})`);
}
