import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { expect, it } from "vitest";
import { sendMessage, sendTurn } from "../src/a2a-client.ts";

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
