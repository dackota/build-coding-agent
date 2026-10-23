// A Streamable HTTP MCP server stub: JSON-RPC over POST, answered as plain JSON (the
// transport allows it). It lists the tools it is given and records every tools/call.
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

/** `result` is the tool's reply text, or a function of the call's arguments. */
export type FakeMcpTool = { name: string; description: string; result: string | ((args: any) => string) };
export type FakeMcp = { url: string; calls: { name: string; args: unknown }[]; close: () => Promise<void> };

type RpcRequest = { jsonrpc: "2.0"; id?: number | string; method: string; params?: { name?: string; arguments?: unknown } };

function answer(req: RpcRequest, tools: FakeMcpTool[], calls: FakeMcp["calls"]): unknown {
  switch (req.method) {
    case "initialize":
      return { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "fake-mcp", version: "0" } };
    case "tools/list":
      return {
        tools: tools.map((t) => ({
          name: t.name,
          description: t.description,
          inputSchema: { type: "object", properties: { branch: { type: "string" } }, required: ["branch"] },
        })),
      };
    case "tools/call": {
      const tool = tools.find((t) => t.name === req.params?.name);
      calls.push({ name: req.params?.name ?? "", args: req.params?.arguments });
      const text = !tool ? "no such tool" : typeof tool.result === "function" ? tool.result(req.params?.arguments) : tool.result;
      return { content: [{ type: "text", text }], isError: !tool };
    }
    default:
      return {};
  }
}

export async function startFakeMcp(tools: FakeMcpTool[]): Promise<FakeMcp> {
  const calls: FakeMcp["calls"] = [];
  const server: Server = createServer((req, res) => {
    if (req.method !== "POST") {
      res.writeHead(405).end();
      return;
    }
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const rpc = JSON.parse(Buffer.concat(chunks).toString("utf8")) as RpcRequest;
      if (rpc.id === undefined) {
        res.writeHead(202).end();
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result: answer(rpc, tools, calls) }));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    calls,
    close: () =>
      new Promise((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  };
}
