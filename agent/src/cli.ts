// Minimal CLI: send one message through the kagent controller and print the reply.
// Usage: pnpm --dir agent run cli -- "<message>"   (env: TEAM, AGENT, AGENT_NAMESPACE, KAGENT_NAMESPACE, KAGENT_URL)
// Attach files with --file <path> (repeatable); the agent replies with its text and a unified diff.
// A pause prints the question and a `paused:` line with the ids; answer it with
//   pnpm --dir agent run cli -- --task <id> --context <id> --request <id> "<answer>" ["<answer 2>" ...]
// (one answer per question, in order). A tool approval pause prints the command and a
// `paused: ... approval=<id>` line; decide it with
//   pnpm --dir agent run cli -- --task <id> --context <id> --approval <id> --approve | --approve-session | --deny "<reason>"
// A reply prints `context=<id>` on stderr; continue the session with `--context <id> "<message>"`.
// Every call sends the kagent HITL extension header.
// Without KAGENT_URL it opens a kubectl port-forward to the controller on kind-build-coding-agent,
// in KAGENT_NAMESPACE (default kagent); the agent is AGENT (default hello-agent) in namespace
// team-<TEAM> (default platform), or in AGENT_NAMESPACE when it is set.
import { type ChildProcess, spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { createServer } from "node:net";
import { basename, isAbsolute, relative, resolve, sep } from "node:path";
import { cancelTask, sendTurn, type StreamEvent, type Turn } from "./a2a-client.ts";
import type { ApprovalDecision } from "./hitl.ts";

const CONTEXT = "kind-build-coding-agent";
const CONTROLLER_A2A_PORT = 8083;
const FORWARD_WAIT_MS = 15_000;
const DEFAULT_CONTROLLER_NAMESPACE = "kagent";
// The agent is AGENT in namespace team-<TEAM>: today's agent, hello-agent of the platform team, by default.
const DEFAULT_TEAM = "platform";
const DEFAULT_AGENT = "hello-agent";
// A team name as platform/teams.sh and the values-file schema allow it.
const TEAM_NAME = /^[a-z]([a-z0-9-]{0,18}[a-z0-9])?$/;

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address() as { port: number };
      srv.close(() => resolve(port));
    });
  });
}

async function openForward(controllerNamespace: string): Promise<{ baseUrl: string; child: ChildProcess }> {
  const port = await freePort();
  const child = spawn(
    "kubectl",
    ["--context", CONTEXT, "port-forward", "-n", controllerNamespace, "svc/kagent-controller", `${port}:${CONTROLLER_A2A_PORT}`],
    { stdio: ["ignore", "ignore", "inherit"] },
  );
  const deadline = Date.now() + FORWARD_WAIT_MS;
  while (Date.now() < deadline) {
    try {
      await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(500) });
      return { baseUrl: `http://127.0.0.1:${port}`, child };
    } catch {
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  child.kill();
  throw new Error("kubectl port-forward to kagent-controller did not come up");
}

const RETRY_WINDOW_MS = 120_000;
const RETRY_DELAY_MS = 3_000;

/** The controller answers "retry after the session becomes available" while the agent's actor wakes. */
async function sendWithRetry(send: () => Promise<Turn>, signal: AbortSignal): Promise<Turn> {
  const deadline = Date.now() + RETRY_WINDOW_MS;
  for (;;) {
    try {
      return await send();
    } catch (err) {
      if (signal.aborted || !/retry after/i.test((err as Error).message) || Date.now() > deadline) throw err;
      await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
    }
  }
}

const FLAGS = ["--task", "--context", "--request"] as const;
const FILE_FLAG = "--file";
const APPROVAL_FLAG = "--approval";
const DENY_FLAG = "--deny";
const DECISION_FLAGS = ["--approve", "--approve-session", DENY_FLAG] as const;

type Args = {
  text: string;
  files: string[];
  contextId?: string;
  reply?: { taskId: string; contextId: string; requestId: string; answers: string[][] };
  approval?: { taskId: string; contextId: string; ids: string[]; decision: ApprovalDecision };
};

function fail(message: string): never {
  console.error(message);
  process.exit(2);
}

/** --task T --context C --approval ID[,ID] with one of --approve, --approve-session, --deny "<reason>". */
function approvalArgs(flags: Map<string, string>, decisions: { flag: string; reason: string }[]): Args {
  if (decisions.length !== 1) fail(`a tool approval needs exactly one of ${DECISION_FLAGS.join(", ")}`);
  const ids = (flags.get(APPROVAL_FLAG) ?? "").split(",").filter(Boolean);
  if (!flags.get("--task") || !flags.get("--context") || ids.length === 0) fail(`a tool approval needs --task, --context, and ${APPROVAL_FLAG}`);
  const { flag, reason } = decisions[0]!;
  if (flag === DENY_FLAG && !reason) fail(`${DENY_FLAG} needs a reason`);
  const decision: ApprovalDecision = flag === DENY_FLAG ? { type: "deny", reason } : flag === "--approve-session" ? { type: "approve_session" } : { type: "approve" };
  const text = decision.type === "deny" ? `deny: ${reason}` : decision.type === "approve_session" ? "approve for this session" : "approve";
  return { text, files: [], approval: { taskId: flags.get("--task")!, contextId: flags.get("--context")!, ids, decision } };
}

function parseArgs(argv: string[]): Args {
  const args = argv.filter((a) => a !== "--");
  const flags = new Map<string, string>();
  const files: string[] = [];
  const decisions: { flag: string; reason: string }[] = [];
  const rest: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const flag = FLAGS.find((f) => f === args[i]);
    if (flag || args[i] === APPROVAL_FLAG) flags.set(args[i]!, args[++i] ?? "");
    else if (args[i] === FILE_FLAG) files.push(args[++i] ?? "");
    else if (args[i] === DENY_FLAG) decisions.push({ flag: DENY_FLAG, reason: args[++i] ?? "" });
    else if (DECISION_FLAGS.some((f) => f === args[i])) decisions.push({ flag: args[i]!, reason: "" });
    else rest.push(args[i]!);
  }
  if (files.some((f) => f === "")) fail(`${FILE_FLAG} needs a path`);
  if (flags.has(APPROVAL_FLAG) || decisions.length > 0) return approvalArgs(flags, decisions);
  if (flags.size === 0) return { text: rest.join(" ").trim(), files };
  // --context alone continues the session with a new message.
  if (flags.size === 1 && flags.has("--context")) {
    const contextId = flags.get("--context")!;
    if (!contextId) fail("--context needs a context id");
    return { text: rest.join(" ").trim(), files, contextId };
  }
  const missing = FLAGS.filter((f) => !flags.get(f));
  if (missing.length > 0 || rest.length === 0) fail(`answering a pause needs ${FLAGS.join(", ")} and at least one answer`);
  return {
    text: rest.join("; "),
    files,
    reply: { taskId: flags.get("--task")!, contextId: flags.get("--context")!, requestId: flags.get("--request")!, answers: rest.map((a) => [a]) },
  };
}

function printTurn(turn: Turn, hasStreamedText: boolean): void {
  if (turn.state === "failed") throw new Error(`the agent failed: ${turn.text}`);
  if (turn.approval) {
    console.log(`tool_approval_request: ${turn.approval.hint}`);
    for (const t of turn.approval.tools) console.log(`tool: ${t.name} ${JSON.stringify(t.args)}`);
    console.log(`paused: task=${turn.taskId} context=${turn.contextId} approval=${turn.approval.tools.map((t) => t.id).join(",")}`);
    return;
  }
  if (!turn.pause) {
    if (!turn.text && !hasStreamedText) throw new Error("the agent sent an empty reply");
    // Streamed text is already on screen: print only what follows the reply (the diff).
    const rest = hasStreamedText ? (turn.artifactTexts ?? []).slice(1).join("\n") : turn.text;
    if (rest) console.log(rest);
    // On stderr, so stdout stays the reply: the id to continue this session with --context.
    if (turn.contextId) console.error(`context=${turn.contextId}`);
    return;
  }
  for (const q of turn.pause.questions) {
    console.log(`question: ${q.question}`);
    if (q.choices.length > 0) console.log(`choices: ${q.choices.join(" | ")}${q.multiple ? " (more than one allowed)" : ""}`);
  }
  console.log(`paused: task=${turn.taskId} context=${turn.contextId} request=${turn.pause.requestId}`);
}

/**
 * Reads each attached file. A relative path inside the directory the user ran from keeps its
 * path as the workspace name (src/a.ts); anything else is sent by its base name.
 * pnpm --dir runs this in agent/, so relative paths resolve against INIT_CWD, where pnpm was run.
 */
function readAttachments(paths: string[]): { name: string; content: Buffer }[] {
  const from = process.env.INIT_CWD ?? process.cwd();
  return paths.map((p) => {
    const full = resolve(from, p);
    const rel = relative(from, full);
    const name = rel === "" || rel.startsWith("..") || isAbsolute(rel) ? basename(full) : rel.split(sep).join("/");
    return { name, content: readFileSync(full) };
  });
}

const { text, files: filePaths, contextId, reply, approval } = parseArgs(process.argv.slice(2));
if (!text) {
  console.error('usage: pnpm --dir agent run cli -- [--file <path>]... "<message>"');
  process.exit(2);
}
let files: { name: string; content: Buffer }[];
try {
  files = readAttachments(filePaths);
} catch (err) {
  console.error(`cannot read an attached file: ${(err as Error).message}`);
  process.exit(2);
}
const CTRL_C_EXIT_CODE = 130;
const ARGS_PREVIEW_CHARS = 120;
// Two namespaces: the controller's (kagent's install) for the port-forward, the agent's for its path.
const controllerNamespace = process.env.KAGENT_NAMESPACE || DEFAULT_CONTROLLER_NAMESPACE;
const team = process.env.TEAM || DEFAULT_TEAM;
if (!TEAM_NAME.test(team)) fail(`TEAM ${JSON.stringify(team)} is not a team name (lower-case letters, digits and dashes)`);
const agentNamespace = process.env.AGENT_NAMESPACE || `team-${team}`;
const agent = process.env.AGENT || DEFAULT_AGENT;
const forward = process.env.KAGENT_URL ? undefined : await openForward(controllerNamespace);
const baseUrl = process.env.KAGENT_URL || forward!.baseUrl;
const abort = new AbortController();
let ids: { taskId: string; contextId: string } | undefined = contextId ? { taskId: "", contextId } : undefined;
let hasStreamedText = false;
let isAtLineStart = true;

/** Text goes out as it streams; a tool call gets its own line when it starts. */
function show(event: StreamEvent): void {
  if (event.type === "text_delta") {
    process.stdout.write(event.text);
    hasStreamedText = true;
    isAtLineStart = event.text.endsWith("\n");
    return;
  }
  if (event.type === "loop_step") {
    process.stdout.write(`${isAtLineStart ? "" : "\n"}> implement ${event.step} (round ${event.round}): ${event.result}\n`);
    isAtLineStart = true;
    return;
  }
  const args = JSON.stringify(event.args ?? {});
  process.stdout.write(`${isAtLineStart ? "" : "\n"}> ${event.name} ${args.length > ARGS_PREVIEW_CHARS ? `${args.slice(0, ARGS_PREVIEW_CHARS)}...` : args}\n`);
  isAtLineStart = true;
}

/** Ctrl-C: stop the turn on the agent (the session keeps the finished steps), say how to continue, leave. */
let isInterrupted = false;
process.once("SIGINT", () => {
  isInterrupted = true;
  abort.abort();
  void (async () => {
    if (ids?.taskId) {
      await cancelTask({ baseUrl, namespace: agentNamespace, agent, taskId: ids.taskId }).catch((err: Error) => console.error(`could not cancel the turn: ${err.message}`));
    }
    if (ids?.contextId) console.error(`\ncontext=${ids.contextId}\ninterrupted; continue with: --context ${ids.contextId} "<message>"`);
    forward?.child.kill();
    process.exit(CTRL_C_EXIT_CODE);
  })();
});

try {
  const turn = await sendWithRetry(
    () => sendTurn({ baseUrl, namespace: agentNamespace, agent, text, files, contextId, reply, approval, onEvent: show, onIds: (got) => (ids = got), signal: abort.signal }),
    abort.signal,
  );
  if (hasStreamedText && !isAtLineStart) process.stdout.write("\n");
  printTurn(turn, hasStreamedText);
} catch (err) {
  if (!isInterrupted) {
    console.error((err as Error).message);
    process.exitCode = 1;
  }
} finally {
  if (!isInterrupted) forward?.child.kill();
}
