// Minimal CLI: send one message through the kagent controller and print the reply.
// Usage: pnpm --dir agent run cli -- "<message>"   (env: AGENT, AGENT_NAMESPACE, KAGENT_URL)
// A pause prints the question and a `paused:` line with the ids; answer it with
//   pnpm --dir agent run cli -- --task <id> --context <id> --request <id> "<answer>" ["<answer 2>" ...]
// (one answer per question, in order). Every call sends the kagent HITL extension header.
// Without KAGENT_URL it opens a kubectl port-forward to the controller on kind-build-coding-agent.
import { type ChildProcess, spawn } from "node:child_process";
import { createServer } from "node:net";
import { sendTurn, type Turn } from "./a2a-client.ts";

const CONTEXT = "kind-build-coding-agent";
const CONTROLLER_A2A_PORT = 8083;
const FORWARD_WAIT_MS = 15_000;

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

async function openForward(namespace: string): Promise<{ baseUrl: string; child: ChildProcess }> {
  const port = await freePort();
  const child = spawn(
    "kubectl",
    ["--context", CONTEXT, "port-forward", "-n", namespace, "svc/kagent-controller", `${port}:${CONTROLLER_A2A_PORT}`],
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
async function sendWithRetry(send: () => Promise<Turn>): Promise<Turn> {
  const deadline = Date.now() + RETRY_WINDOW_MS;
  for (;;) {
    try {
      return await send();
    } catch (err) {
      if (!/retry after/i.test((err as Error).message) || Date.now() > deadline) throw err;
      await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
    }
  }
}

const FLAGS = ["--task", "--context", "--request"] as const;

function parseArgs(argv: string[]): { text: string; reply?: { taskId: string; contextId: string; requestId: string; answers: string[][] } } {
  const args = argv.filter((a) => a !== "--");
  const flags = new Map<string, string>();
  const rest: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const flag = FLAGS.find((f) => f === args[i]);
    if (flag) flags.set(flag, args[++i] ?? "");
    else rest.push(args[i]!);
  }
  if (flags.size === 0) return { text: rest.join(" ").trim() };
  const missing = FLAGS.filter((f) => !flags.get(f));
  if (missing.length > 0 || rest.length === 0) {
    console.error(`answering a pause needs ${FLAGS.join(", ")} and at least one answer`);
    process.exit(2);
  }
  return {
    text: rest.join("; "),
    reply: { taskId: flags.get("--task")!, contextId: flags.get("--context")!, requestId: flags.get("--request")!, answers: rest.map((a) => [a]) },
  };
}

function printTurn(turn: Turn): void {
  if (turn.state === "failed") throw new Error(`the agent failed: ${turn.text}`);
  if (!turn.pause) {
    if (!turn.text) throw new Error("the agent sent an empty reply");
    console.log(turn.text);
    return;
  }
  for (const q of turn.pause.questions) {
    console.log(`question: ${q.question}`);
    if (q.choices.length > 0) console.log(`choices: ${q.choices.join(" | ")}${q.multiple ? " (more than one allowed)" : ""}`);
  }
  console.log(`paused: task=${turn.taskId} context=${turn.contextId} request=${turn.pause.requestId}`);
}

const { text, reply } = parseArgs(process.argv.slice(2));
if (!text) {
  console.error('usage: pnpm --dir agent run cli -- "<message>"');
  process.exit(2);
}
const namespace = process.env.AGENT_NAMESPACE ?? "kagent";
const agent = process.env.AGENT ?? "hello-agent";
const forward = process.env.KAGENT_URL ? undefined : await openForward(namespace);
try {
  const baseUrl = process.env.KAGENT_URL || forward!.baseUrl;
  printTurn(await sendWithRetry(() => sendTurn({ baseUrl, namespace, agent, text, reply })));
} catch (err) {
  console.error((err as Error).message);
  process.exitCode = 1;
} finally {
  forward?.child.kill();
}
