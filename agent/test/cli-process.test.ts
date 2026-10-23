import { type ChildProcess, spawn } from "node:child_process";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { expect, it } from "vitest";
import { AGENT_DIR, waitFor } from "./helpers.ts";

const HITL_URI = "https://kagent.dev/extensions/hitl/v1";
const EVENT_KEY = "build-coding-agent/event";
const sse = (result: unknown) => `data: ${JSON.stringify({ jsonrpc: "2.0", id: 1, result })}\n\n`;

/** A controller whose streaming turn prints one tool call and then never ends; it records every request. */
async function hangingController() {
  const seen: { headers: Record<string, unknown>; body: any }[] = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const parsed = JSON.parse(body);
      seen.push({ headers: req.headers, body: parsed });
      if (parsed.method === "CancelTask") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { id: "t-1", contextId: "c-1", status: { state: "TASK_STATE_CANCELED" } } }));
        return;
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(sse({ task: { id: "t-1", contextId: "c-1", status: { state: "TASK_STATE_WORKING" } } }));
      res.write(
        sse({
          statusUpdate: {
            taskId: "t-1",
            contextId: "c-1",
            status: { state: "TASK_STATE_WORKING", message: { role: "ROLE_AGENT", parts: [{ text: "" }], metadata: { [EVENT_KEY]: { type: "tool_call", name: "read_file", args: { path: "a.txt" } } } } },
          },
        }),
      );
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen, close: () => { server.close(); server.closeAllConnections(); } };
}

function runCli(url: string, message: string): { child: ChildProcess; out: () => { stdout: string; stderr: string }; exited: Promise<number | null> } {
  const child = spawn("node", ["src/cli.ts", "--", message], { cwd: AGENT_DIR, env: { PATH: process.env.PATH ?? "", KAGENT_URL: url }, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (d: Buffer) => (stdout += d.toString()));
  child.stderr?.on("data", (d: Buffer) => (stderr += d.toString()));
  const exited = new Promise<number | null>((r) => child.once("exit", (code) => r(code)));
  return { child, out: () => ({ stdout, stderr }), exited };
}

it("the CLI process sends the HITL header on its message and prints the tool call as it starts", async () => {
  const controller = await hangingController();
  const cli = runCli(controller.url, "hello");
  const shown = await waitFor(async () => cli.out().stdout.includes("read_file"));
  cli.child.kill("SIGINT");
  await cli.exited;
  controller.close();

  expect(shown).toBeTruthy();
  expect(controller.seen[0]?.headers["a2a-extensions"]).toBe(HITL_URI);
  expect(controller.seen[0]?.body.method).toBe("SendStreamingMessage");
});

it("Ctrl-C cancels the running task, prints the context id and exits 130", async () => {
  const controller = await hangingController();
  const cli = runCli(controller.url, "hello");
  await waitFor(async () => cli.out().stdout.includes("read_file"));
  cli.child.kill("SIGINT");
  const code = await cli.exited;
  controller.close();

  expect(code).toBe(130);
  const cancel = controller.seen.find((s) => s.body.method === "CancelTask");
  expect(cancel?.body.params.id).toBe("t-1");
  expect(cancel?.headers["a2a-extensions"]).toBe(HITL_URI);
  expect(cli.out().stderr).toContain("context=c-1");
  expect(cli.out().stderr).not.toMatch(/at .*\.ts:\d+/);
});
