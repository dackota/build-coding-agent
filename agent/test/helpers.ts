import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { type AddressInfo, createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import * as grpc from "@grpc/grpc-js";
import { Role } from "@a2a-js/sdk";
import { ClientFactory, ClientFactoryOptions } from "@a2a-js/sdk/client";
import { GrpcTransportFactory } from "@a2a-js/sdk/client/grpc";

export const AGENT_DIR = fileURLToPath(new URL("..", import.meta.url));
export const SCRIPTED_REPLY = "The scripted model says forty-two.";
export const KEY_SENTINEL = "sentinel-value-that-must-never-leak";

export async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createNetServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address() as AddressInfo;
      srv.close(() => resolve(port));
    });
  });
}

export type FakeModel = {
  baseUrl: string;
  requests: { headers: Record<string, string | string[] | undefined>; body: string }[];
  close: () => Promise<void>;
};

export type ScriptedReply = string | { toolCall: { name: string; args: unknown } };

/**
 * An OpenAI-compatible chat completions stub that plays `script` in order (the last entry
 * repeats). A string is a text reply; `{ toolCall }` makes the model call a tool.
 */
export async function startFakeModel(script: ScriptedReply | ScriptedReply[] = SCRIPTED_REPLY): Promise<FakeModel> {
  const replies = Array.isArray(script) ? script : [script];
  const requests: FakeModel["requests"] = [];
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const index = Math.min(requests.length, replies.length - 1);
      requests.push({ headers: req.headers, body: Buffer.concat(chunks).toString("utf8") });
      if (req.method !== "POST" || req.url !== "/v1/chat/completions") {
        res.writeHead(404).end();
        return;
      }
      const reply = replies[index]!;
      const message =
        typeof reply === "string"
          ? { role: "assistant", content: reply }
          : {
              role: "assistant",
              content: null,
              tool_calls: [
                { id: `call_${index}`, type: "function", function: { name: reply.toolCall.name, arguments: JSON.stringify(reply.toolCall.args) } },
              ],
            };
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          id: "chatcmpl-fake",
          object: "chat.completion",
          created: 1,
          model: "scripted-model",
          choices: [{ index: 0, message, finish_reason: typeof reply === "string" ? "stop" : "tool_calls" }],
          usage: { prompt_tokens: 3, completion_tokens: 5, total_tokens: 8 },
        }),
      );
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    requests,
    close: () => new Promise((r) => server.close(() => r())),
  };
}

export function writeFakeConfig(baseUrl: string, opts: { controlPlaneUrl?: string; subAgents?: unknown[] } = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "agent-config-"));
  const path = join(dir, "config.json");
  writeFileSync(
    path,
    JSON.stringify({
      runtime: {
        gateway_url: "http://unused",
        ...(opts.controlPlaneUrl ? { control_plane_url: opts.controlPlaneUrl } : {}),
        name: "hello-agent",
        namespace: "kagent",
        port: 80,
      },
      agent: {
        model: { model: "scripted-model", openai: { base_url: baseUrl, api_format: "chat_completions" } },
        description: "test",
        instruction: "You are a test agent. Reply briefly.",
        stream: false,
        ...(opts.subAgents ? { sub_agents: opts.subAgents } : {}),
      },
    }),
  );
  return path;
}

export type RunningAgent = {
  grpcPort: number;
  readyzPort: number;
  output: () => string;
  stop: () => Promise<void>;
};

export async function startAgent(configPath: string, extraEnv: Record<string, string> = {}): Promise<RunningAgent> {
  const grpcPort = await freePort();
  const readyzPort = await freePort();
  let out = "";
  const child: ChildProcess = spawn("node", ["src/main.ts"], {
    cwd: AGENT_DIR,
    env: {
      PATH: process.env.PATH ?? "",
      KAGENT_CONFIG_PATH: configPath,
      KAGENT_GRPC_ADDR: `127.0.0.1:${grpcPort}`,
      KAGENT_READYZ_PORT: String(readyzPort),
      // Each turn opens a workspace under the data dir; /data does not exist on a dev machine.
      AGENT_DATA_DIR: mkdtempSync(join(tmpdir(), "agent-data-")),
      ...extraEnv,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.on("data", (d: Buffer) => (out += d.toString()));
  child.stderr?.on("data", (d: Buffer) => (out += d.toString()));
  return {
    grpcPort,
    readyzPort,
    output: () => out,
    stop: () =>
      new Promise((resolve) => {
        if (child.exitCode !== null) return resolve();
        child.once("exit", () => resolve());
        child.kill("SIGTERM");
      }),
  };
}

/** The HTTP status of GET /readyz, or null when nothing answers. */
export async function readyzStatus(port: number): Promise<number | null> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/readyz`, { signal: AbortSignal.timeout(500) });
    return res.status;
  } catch {
    return null;
  }
}

export async function waitFor<T>(probe: () => Promise<T | null | false>, timeoutMs = 8000): Promise<T | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const got = await probe();
    if (got) return got;
    await new Promise((r) => setTimeout(r, 50));
  }
  return null;
}

/** Send one text message over A2A gRPC and return the reply text parts joined. */
export async function grpcClient(port: number, opts: { failFast?: boolean } = {}) {
  const factory = new ClientFactory(
    ClientFactoryOptions.createFrom(ClientFactoryOptions.default, {
      transports: [
        new GrpcTransportFactory({
          grpcChannelCredentials: grpc.credentials.createInsecure(),
          // failFast false (the default) would wait for the channel; true fails on a refused connection.
          grpcCallOptions: opts.failFast ? ({ waitForReady: false } as never) : undefined,
        }),
      ],
    }),
  );
  return factory.createFromAgentCard({
    name: "test",
    description: "",
    supportedInterfaces: [{ url: `127.0.0.1:${port}`, protocolBinding: "GRPC", tenant: "", protocolVersion: "1.0" }],
    provider: undefined,
    version: "0",
    capabilities: { extensions: [] },
    securitySchemes: {},
    securityRequirements: [],
    defaultInputModes: ["text/plain"],
    defaultOutputModes: ["text/plain"],
    skills: [],
    signatures: [],
  });
}

export type TaskReply = {
  state: number;
  contextId: string;
  /** Artifact text by artifact name ("reply", "diff"). */
  artifacts: Record<string, string>;
  /** The status message text (a failure says why). */
  statusText: string;
};

/** One SendMessage with a task text and files attached as raw parts named by their workspace path. */
export async function sendTask(port: number, text: string, files: Record<string, string> = {}, contextId = ""): Promise<TaskReply> {
  const client = await grpcClient(port);
  const fileParts = Object.entries(files).map(([filename, content]) => ({
    content: { $case: "raw" as const, value: Buffer.from(content, "utf8") },
    metadata: undefined,
    filename,
    mediaType: "text/plain",
  }));
  const result: any = await client.sendMessage({
    tenant: "",
    message: {
      messageId: crypto.randomUUID(),
      contextId,
      taskId: "",
      role: Role.ROLE_USER,
      parts: [...fileParts, { content: { $case: "text", value: text }, metadata: undefined, filename: "", mediaType: "" }],
      metadata: undefined,
      extensions: [],
      referenceTaskIds: [],
    },
    configuration: undefined,
    metadata: undefined,
  });
  const textOf = (parts: any[] = []) => parts.map((p) => (p.content?.$case === "text" ? p.content.value : "")).join("");
  const artifacts: Record<string, string> = {};
  for (const a of result.artifacts ?? []) artifacts[a.name] = textOf(a.parts);
  return { state: Number(result.status?.state), contextId: result.contextId, artifacts, statusText: textOf(result.status?.message?.parts) };
}

/** Retries sendTask until the agent answers (it may still be starting). */
export async function sendTaskWhenUp(port: number, text: string, files: Record<string, string> = {}, contextId = ""): Promise<TaskReply> {
  const got = await waitFor(async () => {
    try {
      return await sendTask(port, text, files, contextId);
    } catch {
      return null;
    }
  });
  if (!got) throw new Error("no reply from the agent");
  return got;
}

/** The tool results the agent sent back to the model, in order, across all model requests. */
export function toolResults(model: FakeModel): string[] {
  const last = model.requests.at(-1);
  if (!last) return [];
  const body = JSON.parse(last.body) as { messages: { role: string; content: string }[] };
  return body.messages.filter((m) => m.role === "tool").map((m) => m.content);
}

export async function sendOverGrpc(
  port: number,
  text: string,
  opts: { failFast?: boolean } = {},
): Promise<{ reply: string; kind: "message" | "task"; contextId: string }> {
  const client = await grpcClient(port, opts);
  const result = await client.sendMessage({
    tenant: "",
    message: {
      messageId: "m-1",
      contextId: "",
      taskId: "",
      role: Role.ROLE_USER,
      parts: [{ content: { $case: "text", value: text }, metadata: undefined, filename: "", mediaType: "" }],
      metadata: undefined,
      extensions: [],
      referenceTaskIds: [],
    },
    configuration: undefined,
    metadata: undefined,
  });
  const parts = "artifacts" in result
    ? result.artifacts.flatMap((a) => a.parts)
    : result.parts;
  const reply = parts.map((p) => (p.content?.$case === "text" ? p.content.value : "")).join("");
  return { reply, kind: "status" in result ? "task" : "message", contextId: result.contextId };
}
