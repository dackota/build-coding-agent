import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { describe, expect, it } from "vitest";
import { sendMessage, sendTurn } from "../src/a2a-client.ts";
import { AGENT_DIR } from "./helpers.ts";

const HITL_URI = "https://kagent.dev/extensions/hitl/v1";

it("sends one SendMessage to the controller's agent endpoint and returns the reply text", async () => {
  let seen: { url?: string; headers: Record<string, unknown>; body: string } = { headers: {}, body: "" };
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      seen = { url: req.url, headers: req.headers, body };
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          result: { task: { artifacts: [{ parts: [{ text: "forty-" }, { text: "two" }] }] } },
        }),
      );
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;

  const reply = await sendMessage({ baseUrl: `http://127.0.0.1:${port}`, namespace: "kagent", agent: "hello-agent", text: "hi" });
  server.close();

  expect(reply).toBe("forty-two");
  expect(seen.url).toBe("/agents/kagent/hello-agent");
  expect(seen.headers["a2a-version"]).toBe("1.0");
  expect(JSON.parse(seen.body)).toMatchObject({ method: "SendMessage", params: { message: { role: "ROLE_USER", parts: [{ text: "hi" }] } } });
});

it("throws when the controller answers a JSON-RPC error", async () => {
  const server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32000, message: "agent down" } }));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  await expect(
    sendMessage({ baseUrl: `http://127.0.0.1:${port}`, namespace: "kagent", agent: "a", text: "x" }),
  ).rejects.toThrow(/agent down/);
  server.close();
});

const PAUSED = {
  jsonrpc: "2.0",
  id: 1,
  result: {
    task: {
      id: "task-9",
      contextId: "ctx-9",
      status: {
        state: "TASK_STATE_INPUT_REQUIRED",
        message: {
          role: "ROLE_AGENT",
          parts: [{ text: "Which colour?" }],
          extensions: [HITL_URI],
          metadata: {
            [HITL_URI]: { type: "ask_user_request", id: "req-1", questions: [{ question: "Which colour?", choices: ["red", "blue"], multiple: false }] },
          },
        },
      },
    },
  },
};

async function stubController(reply: unknown) {
  const seen: { headers: Record<string, unknown>; body: any }[] = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      seen.push({ headers: req.headers, body: JSON.parse(body) });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(reply));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  return { baseUrl: `http://127.0.0.1:${port}`, seen, close: () => server.close() };
}

it("sends the A2A-Extensions HITL header on every message", async () => {
  const stub = await stubController(PAUSED);
  await sendMessage({ baseUrl: stub.baseUrl, namespace: "kagent", agent: "a", text: "hi" }).catch(() => undefined);
  await sendTurn({ baseUrl: stub.baseUrl, namespace: "kagent", agent: "a", text: "hi" });
  await sendTurn({
    baseUrl: stub.baseUrl,
    namespace: "kagent",
    agent: "a",
    text: "blue",
    reply: { taskId: "task-9", contextId: "ctx-9", requestId: "req-1", answers: [["blue"]] },
  });
  stub.close();

  expect(stub.seen).toHaveLength(3);
  for (const s of stub.seen) expect(s.headers["a2a-extensions"]).toBe(HITL_URI);
});

it("reads a pause from the controller's reply: state, ids, and the questions", async () => {
  const stub = await stubController(PAUSED);
  const got = await sendTurn({ baseUrl: stub.baseUrl, namespace: "kagent", agent: "a", text: "hi" });
  stub.close();

  expect(got.state).toBe("input-required");
  expect(got.taskId).toBe("task-9");
  expect(got.contextId).toBe("ctx-9");
  expect(got.pause).toEqual({ requestId: "req-1", questions: [{ question: "Which colour?", choices: ["red", "blue"], multiple: false }] });
  expect(got.text).toBe("Which colour?");
});

it("continues a session: a new turn on the given context, with no task id", async () => {
  const stub = await stubController({ jsonrpc: "2.0", id: 1, result: { task: { id: "task-2", contextId: "ctx-9", status: { state: "TASK_STATE_COMPLETED" }, artifacts: [{ parts: [{ text: "42" }] }] } } });
  const got = await sendTurn({ baseUrl: stub.baseUrl, namespace: "kagent", agent: "a", text: "what number?", contextId: "ctx-9" });
  stub.close();

  const message = stub.seen[0]?.body.params.message;
  expect(message.contextId).toBe("ctx-9");
  expect(message.taskId).toBeUndefined();
  expect(message.metadata).toBeUndefined();
  expect(got.contextId).toBe("ctx-9");
  expect(got.text).toBe("42");
});

it("answers a pause with an ask_user_response on the same task and context", async () => {
  const stub = await stubController({ jsonrpc: "2.0", id: 1, result: { task: { id: "task-9", contextId: "ctx-9", status: { state: "TASK_STATE_COMPLETED" }, artifacts: [{ parts: [{ text: "Done: blue." }] }] } } });
  const got = await sendTurn({
    baseUrl: stub.baseUrl,
    namespace: "kagent",
    agent: "a",
    text: "blue",
    reply: { taskId: "task-9", contextId: "ctx-9", requestId: "req-1", answers: [["blue"]] },
  });
  stub.close();

  const message = stub.seen[0]?.body.params.message;
  expect(message.taskId).toBe("task-9");
  expect(message.contextId).toBe("ctx-9");
  expect(message.extensions).toEqual([HITL_URI]);
  expect(message.metadata[HITL_URI]).toEqual({ type: "ask_user_response", id: "req-1", answers: [{ answer: ["blue"] }] });
  expect(got.state).toBe("completed");
  expect(got.text).toBe("Done: blue.");
});

it("sends attached files as raw parts with their file names", async () => {
  const stub = await stubController({ jsonrpc: "2.0", id: 1, result: { task: { id: "t", contextId: "c", status: { state: "TASK_STATE_COMPLETED" }, artifacts: [] } } });
  await sendTurn({
    baseUrl: stub.baseUrl,
    namespace: "kagent",
    agent: "a",
    text: "rename foo to bar",
    files: [{ name: "greet.js", content: Buffer.from("function foo() {}\n") }],
  });
  stub.close();

  const parts = stub.seen[0]?.body.params.message.parts;
  expect(parts).toEqual([
    { raw: Buffer.from("function foo() {}\n").toString("base64"), filename: "greet.js", mediaType: "text/plain" },
    { text: "rename foo to bar" },
  ]);
});

it("prints each artifact on its own line: the reply, then the diff", async () => {
  const stub = await stubController({
    jsonrpc: "2.0",
    id: 1,
    result: { task: { id: "t", contextId: "c", status: { state: "TASK_STATE_COMPLETED" }, artifacts: [{ name: "reply", parts: [{ text: "Renamed." }] }, { name: "diff", parts: [{ text: "--- a/x\n+++ b/x\n" }] }] } },
  });
  const got = await sendTurn({ baseUrl: stub.baseUrl, namespace: "kagent", agent: "a", text: "go" });
  stub.close();

  expect(got.text).toBe("Renamed.\n--- a/x\n+++ b/x\n");
});

const APPROVAL_PAUSED = {
  jsonrpc: "2.0",
  id: 1,
  result: {
    task: {
      id: "task-5",
      contextId: "ctx-5",
      status: {
        state: "TASK_STATE_INPUT_REQUIRED",
        message: {
          role: "ROLE_AGENT",
          parts: [{ text: 'Run "rm -rf build" in the workspace? (bash)' }],
          extensions: [HITL_URI],
          metadata: {
            [HITL_URI]: {
              type: "tool_approval_request",
              hint: 'Run "rm -rf build" in the workspace? (bash)',
              tools: [{ id: "appr-1", call_id: "call-1", name: "bash", args: { command: "rm -rf build" } }],
            },
          },
        },
      },
    },
  },
};

it("reads a tool approval pause: the tools, ids and hint", async () => {
  const stub = await stubController(APPROVAL_PAUSED);
  const got = await sendTurn({ baseUrl: stub.baseUrl, namespace: "kagent", agent: "a", text: "clean" });
  stub.close();

  expect(got.state).toBe("input-required");
  expect(got.pause).toBeUndefined();
  expect(got.approval).toEqual({
    hint: 'Run "rm -rf build" in the workspace? (bash)',
    tools: [{ id: "appr-1", name: "bash", args: { command: "rm -rf build" } }],
  });
});

it("answers a tool approval pause with each decision of the union", async () => {
  const stub = await stubController({ jsonrpc: "2.0", id: 1, result: { task: { id: "task-5", contextId: "ctx-5", status: { state: "TASK_STATE_COMPLETED" }, artifacts: [] } } });
  const decisions = [
    { type: "approve" as const },
    { type: "deny" as const, reason: "keep build" },
    { type: "approve_session" as const },
  ];
  for (const decision of decisions) {
    await sendTurn({
      baseUrl: stub.baseUrl,
      namespace: "kagent",
      agent: "a",
      text: decision.type,
      approval: { taskId: "task-5", contextId: "ctx-5", ids: ["appr-1"], decision },
    });
  }
  stub.close();

  const sent = stub.seen.map((s) => s.body.params.message);
  for (const m of sent) {
    expect(m.taskId).toBe("task-5");
    expect(m.contextId).toBe("ctx-5");
    expect(m.extensions).toEqual([HITL_URI]);
  }
  expect(sent.map((m) => m.metadata[HITL_URI])).toEqual([
    { type: "tool_approval_response", approvals: [{ id: "appr-1", approved: true }] },
    { type: "tool_approval_response", approvals: [{ id: "appr-1", approved: false, rejection_reason: "keep build" }] },
    { type: "tool_approval_response", approvals: [{ id: "appr-1", approved: true, scope: "session" }] },
  ]);
});

const EVENT_KEY = "build-coding-agent/event";
const sse = (result: unknown) => `data: ${JSON.stringify({ jsonrpc: "2.0", id: 1, result })}\n\n`;
const working = (event: unknown, text = "") => ({
  statusUpdate: { taskId: "t-1", contextId: "c-1", status: { state: "TASK_STATE_WORKING", message: { role: "ROLE_AGENT", parts: [{ text }], metadata: { [EVENT_KEY]: event } } } },
});

async function stubStream(chunks: string[]) {
  const seen: { headers: Record<string, unknown>; body: any }[] = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      seen.push({ headers: req.headers, body: JSON.parse(body) });
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(chunks.join(""));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  return { baseUrl: `http://127.0.0.1:${port}`, seen, close: () => server.close() };
}

it("streams text deltas and tool calls to the caller as they arrive", async () => {
  const stub = await stubStream([
    sse({ task: { id: "t-1", contextId: "c-1", status: { state: "TASK_STATE_WORKING" } } }),
    sse(working({ type: "tool_call", name: "read_file", args: { path: "a.txt" } })),
    sse(working({ type: "text_delta", text: "Hel" }, "Hel")),
    sse(working({ type: "text_delta", text: "lo" }, "lo")),
    sse({ artifactUpdate: { taskId: "t-1", contextId: "c-1", artifact: { name: "reply", parts: [{ text: "Hello" }] }, lastChunk: true } }),
    sse({ statusUpdate: { taskId: "t-1", contextId: "c-1", status: { state: "TASK_STATE_COMPLETED" } } }),
  ]);
  const events: unknown[] = [];
  const turn = await sendTurn({ baseUrl: stub.baseUrl, namespace: "kagent", agent: "a", text: "hi", onEvent: (e) => events.push(e) });
  stub.close();

  expect(events).toEqual([
    { type: "tool_call", name: "read_file", args: { path: "a.txt" } },
    { type: "text_delta", text: "Hel" },
    { type: "text_delta", text: "lo" },
  ]);
  expect(turn).toMatchObject({ state: "completed", taskId: "t-1", contextId: "c-1", text: "Hello" });
});

it("streaming send also carries the HITL header and uses SendStreamingMessage", async () => {
  const stub = await stubStream([sse({ statusUpdate: { taskId: "t-1", contextId: "c-1", status: { state: "TASK_STATE_COMPLETED" } } })]);
  await sendTurn({ baseUrl: stub.baseUrl, namespace: "kagent", agent: "a", text: "hi", onEvent: () => {} });
  stub.close();

  expect(stub.seen[0]?.body.method).toBe("SendStreamingMessage");
  expect(stub.seen[0]?.headers["a2a-extensions"]).toBe(HITL_URI);
});

it("reads a pause from a stream", async () => {
  const stub = await stubStream([
    sse({
      statusUpdate: {
        taskId: "task-9",
        contextId: "ctx-9",
        status: { state: "TASK_STATE_INPUT_REQUIRED", message: PAUSED.result.task.status.message },
      },
    }),
  ]);
  const got = await sendTurn({ baseUrl: stub.baseUrl, namespace: "kagent", agent: "a", text: "hi", onEvent: () => {} });
  stub.close();

  expect(got.state).toBe("input-required");
  expect(got.pause?.requestId).toBe("req-1");
  expect(got.taskId).toBe("task-9");
});

it("reads a pause from the task snapshot that ends a stream", async () => {
  const stub = await stubStream([
    sse(working({ type: "tool_call", name: "ask_user", args: {} })),
    sse({ task: PAUSED.result.task }),
  ]);
  const got = await sendTurn({ baseUrl: stub.baseUrl, namespace: "kagent", agent: "a", text: "hi", onEvent: () => {} });
  stub.close();

  expect(got.state).toBe("input-required");
  expect(got.pause?.requestId).toBe("req-1");
  expect(got.taskId).toBe("task-9");
  expect(got.contextId).toBe("ctx-9");
});

// A kubectl stand-in: it records its argv, then serves the controller on the forwarded local
// port and records the path of each A2A request, answering with one completed reply.
const FAKE_KUBECTL = `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
import { createServer } from "node:http";
const log = (entry) => appendFileSync(process.env.FAKE_KUBECTL_LOG, JSON.stringify(entry) + "\\n");
const args = process.argv.slice(2);
log({ argv: args });
const port = Number(args.find((a) => /^\\d+:8083$/.test(a)).split(":")[0]);
const sse = (result) => "data: " + JSON.stringify({ jsonrpc: "2.0", id: 1, result }) + "\\n\\n";
createServer((req, res) => {
  if (req.method !== "POST") return res.writeHead(200).end();
  log({ path: req.url });
  req.resume();
  req.on("end", () => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(
      sse({ artifactUpdate: { taskId: "t-1", contextId: "c-1", artifact: { name: "reply", parts: [{ text: "pong" }] }, lastChunk: true } }) +
        sse({ statusUpdate: { taskId: "t-1", contextId: "c-1", status: { state: "TASK_STATE_COMPLETED" } } }),
    );
  });
}).listen(port, "127.0.0.1");
`;

/** Runs the CLI with no KAGENT_URL, so it port-forwards through the fake kubectl; returns what kubectl saw. */
async function runForwardedCli(env: Record<string, string>): Promise<{ code: number | null; stdout: string; forwardNamespace?: string; paths: string[] }> {
  const dir = mkdtempSync(join(tmpdir(), "fake-kubectl-"));
  writeFileSync(join(dir, "kubectl"), FAKE_KUBECTL, { mode: 0o755 });
  const logFile = join(dir, "log.jsonl");
  writeFileSync(logFile, "");
  const child = spawn("node", ["src/cli.ts", "--", "ping"], {
    cwd: AGENT_DIR,
    env: { PATH: `${dir}${delimiter}${process.env.PATH ?? ""}`, FAKE_KUBECTL_LOG: logFile, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
  const code = await new Promise<number | null>((r) => child.once("exit", r));
  const entries = readFileSync(logFile, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as { argv?: string[]; path?: string });
  const argv = entries.find((e) => e.argv)?.argv ?? [];
  const nsAt = argv.indexOf("-n");
  return { code, stdout, forwardNamespace: nsAt >= 0 ? argv[nsAt + 1] : undefined, paths: entries.flatMap((e) => (e.path ? [e.path] : [])) };
}

describe("CLI namespaces", () => {
  it("with no env the CLI port-forwards to the controller in kagent and sends to the agent in agents", async () => {
    const got = await runForwardedCli({});

    expect(got.forwardNamespace).toBe("kagent");
    expect(got.paths).toEqual(["/agents/agents/hello-agent"]);
    expect(got.stdout).toContain("pong");
    expect(got.code).toBe(0);
  });

  it("AGENT_NAMESPACE changes only the agent path", async () => {
    const got = await runForwardedCli({ AGENT_NAMESPACE: "team-a", AGENT: "docs-agent" });

    expect(got.forwardNamespace).toBe("kagent");
    expect(got.paths).toEqual(["/agents/team-a/docs-agent"]);
  });

  it("KAGENT_NAMESPACE changes only the port-forward", async () => {
    const got = await runForwardedCli({ KAGENT_NAMESPACE: "kagent-ctl" });

    expect(got.forwardNamespace).toBe("kagent-ctl");
    expect(got.paths).toEqual(["/agents/agents/hello-agent"]);
  });
});
