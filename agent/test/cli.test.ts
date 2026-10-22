import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { expect, it } from "vitest";
import { sendMessage } from "../src/a2a-client.ts";

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
