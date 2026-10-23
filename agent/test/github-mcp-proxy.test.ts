// The GitHub MCP auth proxy (platform/github-mcp-proxy.mjs) runs beside github-mcp-server in
// its pod and is the only part that holds the token: the agent calls it with no credential.
// Started here with node, as the pod starts it, in front of a fake upstream.
import { type ChildProcess, spawn } from "node:child_process";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";
import { freePort, waitFor } from "./helpers.ts";

const PROXY = fileURLToPath(new URL("../../platform/github-mcp-proxy.mjs", import.meta.url));
const TOKEN = "github_pat_sentinel-that-must-never-leak";

type Upstream = { url: string; seen: { headers: IncomingHttpHeaders; body: string }[]; close: () => Promise<void> };
type Proxy = { url: string; output: () => string; exited: Promise<number | null>; stop: () => void };

let upstream: Upstream | undefined;
let proxy: Proxy | undefined;
afterEach(async () => {
  proxy?.stop();
  await upstream?.close();
  proxy = upstream = undefined;
});

async function startUpstream(): Promise<Upstream> {
  const seen: Upstream["seen"] = [];
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      seen.push({ headers: req.headers, body: Buffer.concat(chunks).toString("utf8") });
      res.writeHead(200, { "content-type": "application/json", "mcp-session-id": "s-1" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { tools: [] } }));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    seen,
    close: () => new Promise((r) => { server.closeAllConnections(); server.close(() => r()); }),
  };
}

function startProxy(env: Record<string, string>, port: number): Proxy {
  const child: ChildProcess = spawn(process.execPath, [PROXY], { env: { PATH: process.env.PATH ?? "", PORT: String(port), ...env }, stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  child.stdout!.on("data", (c: Buffer) => (out += c.toString("utf8")));
  child.stderr!.on("data", (c: Buffer) => (out += c.toString("utf8")));
  const exited = new Promise<number | null>((r) => child.on("exit", (code) => r(code)));
  return { url: `http://127.0.0.1:${port}/`, output: () => out, exited, stop: () => child.kill() };
}

async function post(url: string, headers: Record<string, string> = {}): Promise<Response | null> {
  return waitFor(async () => {
    try {
      return await fetch(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' });
    } catch {
      return null;
    }
  });
}

it("forwards each request to the GitHub MCP server with the token as a bearer header, replacing any the client sent", async () => {
  upstream = await startUpstream();
  proxy = startProxy({ GITHUB_TOKEN: TOKEN, UPSTREAM_URL: upstream.url }, await freePort());

  const plain = await post(proxy.url);
  const spoofed = await post(proxy.url, { authorization: "Bearer someone-else" });

  expect(plain?.status).toBe(200);
  expect(plain?.headers.get("mcp-session-id")).toBe("s-1");
  expect(await plain?.json()).toEqual({ jsonrpc: "2.0", id: 1, result: { tools: [] } });
  expect(spoofed?.status).toBe(200);
  expect(upstream.seen.map((s) => s.headers.authorization)).toEqual([`Bearer ${TOKEN}`, `Bearer ${TOKEN}`]);
  expect(upstream.seen[0]?.body).toBe('{"jsonrpc":"2.0","id":1,"method":"tools/list"}');
});

it("never writes the token to its log, on success or when the upstream is down", async () => {
  upstream = await startUpstream();
  proxy = startProxy({ GITHUB_TOKEN: TOKEN, UPSTREAM_URL: upstream.url }, await freePort());
  expect((await post(proxy.url))?.status).toBe(200);
  await upstream.close();
  upstream = undefined;

  const down = await post(proxy.url);

  expect(down?.status).toBe(502);
  expect(proxy.output()).toContain("upstream-failed");
  expect(proxy.output()).not.toContain(TOKEN);
  expect(await down?.text()).not.toContain(TOKEN);
});

it("refuses to start without GITHUB_TOKEN", async () => {
  proxy = startProxy({ UPSTREAM_URL: "http://127.0.0.1:1" }, await freePort());

  const code = await proxy.exited;

  expect(code).not.toBe(0);
  expect(proxy.output()).toContain("GITHUB_TOKEN");
});
