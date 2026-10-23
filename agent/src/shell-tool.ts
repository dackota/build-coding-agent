// The model's shell tool, run through the Sandbox, with a safety gate at execution time.
// A command is safe only when every segment starts with a program on the allowlist and it has
// no redirect or command substitution; anything else is risky and needs a human decision.
// The gate is checked twice: needsApproval makes the AI SDK pause the turn, and execute
// itself refuses a risky command the gate does not allow, so no path runs it unapproved.
import { tool } from "ai";
import { z } from "zod";
import { EXEC_TIMEOUT_MS } from "./local-sandbox.ts";
import { log } from "./log.ts";
import type { Sandbox } from "./sandbox.ts";

export const SHELL_TOOL = "bash";

/**
 * Programs (or program and subcommand) that only read. A program that writes a file through an
 * ordinary operand or flag (sort -o, uniq IN OUT, tree -o) is left off; one that writes only
 * through a named flag is on, with that flag in WRITE_FLAGS.
 */
export const SAFE_PROGRAMS: string[] = [
  "ls", "cat", "head", "tail", "wc", "pwd", "echo", "grep", "stat", "file", "which", "diff", "true",
  "git status", "git diff", "git log", "git show",
];

const GIT_OUTPUT = { name: "--output", pattern: /^--output(=|$)/ };

/** Flags that make a safe program write a file: such a segment is risky, of kind "<program> <flag>". */
const WRITE_FLAGS: Record<string, { name: string; pattern: RegExp }> = {
  "git diff": GIT_OUTPUT,
  "git log": GIT_OUTPUT,
  "git show": GIT_OUTPUT,
  // file -C (--compile) writes a compiled magic file.
  file: { name: "-C", pattern: /^(--compile|-[A-Za-z]*C[A-Za-z]*)$/ },
};

const MAX_OUTPUT_CHARS = 30_000;
const MAX_LOGGED_COMMAND = 200;
const SEPARATORS = /;|&&|\|\||\||&|\n/;
const REDIRECT = /[<>]/;
const SUBSTITUTION = /\$\(|`/;

export type ApprovalGate = {
  /** Whether a risky call may run: approved for this call, or its kinds approved for the session. */
  allows(toolCallId: string, kinds: string[]): boolean;
  /**
   * Whether this call is the one a human just decided. The AI SDK asks needsApproval again
   * before it runs an approved call, and refuses to run it if the answer is now "no".
   */
  isDecided?(toolCallId: string): boolean;
};

/** The program a segment runs, with the subcommand for git ("git push"). */
function programOf(segment: string): string {
  const [first = "", second = ""] = segment.trim().split(/\s+/);
  return first === "git" ? `git ${second}`.trim() : first;
}

/** Whether a segment of a safe program passes the flag that makes it write a file. */
function writesThroughFlag(program: string, segment: string): boolean {
  const flag = WRITE_FLAGS[program];
  return flag !== undefined && segment.trim().split(/\s+/).some((word) => flag.pattern.test(word));
}

/**
 * The kinds of risk in a command: each risky program it runs ("rm", "git push"), plus
 * "redirect" and "substitution". Empty means safe. "Approve for this session" approves kinds.
 */
export function riskKinds(command: string): string[] {
  const kinds = new Set<string>();
  if (REDIRECT.test(command)) kinds.add("redirect");
  if (SUBSTITUTION.test(command)) kinds.add("substitution");
  for (const segment of command.split(SEPARATORS)) {
    if (segment.trim() === "") continue;
    const program = programOf(segment);
    if (!SAFE_PROGRAMS.includes(program)) kinds.add(program);
    else if (writesThroughFlag(program, segment)) kinds.add(`${program} ${WRITE_FLAGS[program]!.name}`);
  }
  if (command.trim() === "") kinds.add("empty");
  return [...kinds].sort();
}

function capped(text: string): string {
  return text.length > MAX_OUTPUT_CHARS ? `${text.slice(0, MAX_OUTPUT_CHARS)}\n[truncated: ${text.length - MAX_OUTPUT_CHARS} more characters]` : text;
}

const DESCRIPTION = `Run a shell command in the workspace (sh, working directory = workspace root). Returns stdout, stderr, and the exit code.

WHEN TO USE: building, testing, linting, or type-checking code; listing directories; running project scripts (pnpm test, go test, make).

WHEN NOT TO USE: reading one file (use read_file), finding text in files (use search), creating or changing a file (use write_file or edit_file).

DO NOT USE FOR: deleting or moving files, network calls, or installing software unless the task asks for it: these need the user's approval, and a denial comes back with the user's reason.

USAGE: one command string; chain with && when a step depends on the last. Read-only commands (${SAFE_PROGRAMS.join(", ")}) run at once; anything else, any redirect (> <), and any $(...) or backticks pause for approval. Output is capped at ${MAX_OUTPUT_CHARS} characters; a command is stopped after ${EXEC_TIMEOUT_MS / 1000} seconds.

EXAMPLES:
  - List the source tree: command "ls -la src"
  - Run the tests: command "pnpm test"
  - Show what changed: command "git diff"`;

export function createShellTool(sandbox: Sandbox, gate: ApprovalGate) {
  return tool({
    description: DESCRIPTION,
    inputSchema: z.object({ command: z.string().describe("The shell command to run in the workspace") }),
    needsApproval: async ({ command }, { toolCallId }) => {
      const kinds = riskKinds(command);
      return kinds.length > 0 && (gate.isDecided?.(toolCallId) === true || !gate.allows(toolCallId, kinds));
    },
    execute: async ({ command }, { toolCallId }) => {
      const kinds = riskKinds(command);
      if (kinds.length > 0 && !gate.allows(toolCallId, kinds)) {
        log("shell-refused", { toolCallId, command: command.slice(0, MAX_LOGGED_COMMAND), risk: kinds.join(",") });
        throw new Error(`refused: "${command}" is risky (${kinds.join(", ")}) and has no approval`);
      }
      const { stdout, stderr, exitCode, hasTimedOut } = await sandbox.exec(command);
      log("shell", { toolCallId, command: command.slice(0, MAX_LOGGED_COMMAND), risk: kinds.join(","), exitCode });
      const timeoutNote = hasTimedOut ? `timed out after ${EXEC_TIMEOUT_MS / 1000} seconds: the command was stopped, so the output below is partial\n` : "";
      return capped(`${timeoutNote}exit code: ${exitCode}\nstdout:\n${stdout}\nstderr:\n${stderr}`);
    },
  });
}
