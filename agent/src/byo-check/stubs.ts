// Stand-ins for what kagent gives a byo image: the controller's task store (private gRPC,
// versioned, settle only at boundaries) and the gateway's OpenAI-compatible model route.
import { createServer, type Server } from "node:http";
import * as grpc from "@grpc/grpc-js";
import { taskStoreMethods, type Task } from "../wire.ts";
import type { ControllerCall, ModelRequest } from "./rules.ts";

export const SCRIPTED_REPLY = "The contract check says forty-two.";
// TaskState numbers: completed, failed, canceled, rejected are terminal; input- and auth-required wait.
const TERMINAL = new Set([3, 4, 5, 7]);
const WAITING = new Set([6, 8]);
const PLACEHOLDER_BEARER = "Bearer placeholder";

export type ControllerStub = { calls: ControllerCall[]; refusedSettles: () => number; close: () => Promise<void> };
export type ModelStub = { requests: ModelRequest[]; close: () => Promise<void> };

/** Serves TaskStoreService on host:port. It keeps what the real controller enforces. */
export async function startControllerStub(host: string, port: number, sessionId: string): Promise<ControllerStub> {
  const calls: ControllerCall[] = [];
  const tasks = new Map<string, { task: Task; version: number }>();
  const boundaries = new Set<string>();
  let refusedSettles = 0;
  const definition: Record<string, grpc.MethodDefinition<unknown, unknown>> = {};
  const handlers: grpc.UntypedServiceImplementation = {};
  for (const [name, m] of Object.entries(taskStoreMethods)) {
    definition[name] = {
      path: m.path,
      requestStream: false,
      responseStream: false,
      requestSerialize: (v: unknown) => m.request.encode(v as never),
      requestDeserialize: (b: Buffer) => m.request.decode(b),
      responseSerialize: (v: unknown) => m.response.encode(v as never),
      responseDeserialize: (b: Buffer) => m.response.decode(b),
    } as grpc.MethodDefinition<unknown, unknown>;
    handlers[name] = (call: grpc.ServerUnaryCall<Record<string, any>, unknown>, cb: grpc.sendUnaryData<unknown>) => {
      const authorization = call.metadata.get("authorization")[0]?.toString();
      const req = call.request;
      calls.push({ method: name, authorization, sessionId: req.sessionId });
      if (authorization !== PLACEHOLDER_BEARER) return cb({ code: grpc.status.PERMISSION_DENIED, details: "runtime actor identity is required" });
      if (req.sessionId !== sessionId) return cb({ code: grpc.status.PERMISSION_DENIED, details: "actor does not belong to this session" });
      switch (name) {
        case "createTask": {
          if (tasks.has(req.task.id)) return cb({ code: grpc.status.ALREADY_EXISTS, details: "task ID already exists" });
          tasks.set(req.task.id, { task: req.task, version: 1 });
          const state = req.task.status?.state ?? 0;
          if (TERMINAL.has(state) || WAITING.has(state)) boundaries.add(`${req.task.id}@1`);
          return cb(null, { version: 1 });
        }
        case "updateTask": {
          const stored = tasks.get(req.task.id);
          if (!stored) return cb({ code: grpc.status.NOT_FOUND, details: "task does not exist" });
          if (stored.version !== req.expectedVersion) return cb({ code: grpc.status.ABORTED, details: "task changed" });
          if (TERMINAL.has(stored.task.status?.state ?? 0)) return cb({ code: grpc.status.FAILED_PRECONDITION, details: "terminal task" });
          const next = req.task.status?.state ?? 0;
          const isBoundary = TERMINAL.has(next) || (WAITING.has(next) && stored.task.status?.state !== next);
          stored.task = req.task;
          stored.version += 1;
          if (isBoundary) boundaries.add(`${req.task.id}@${stored.version}`);
          return cb(null, { version: stored.version });
        }
        case "getTask": {
          const stored = tasks.get(req.taskId);
          if (!stored) return cb({ code: grpc.status.NOT_FOUND, details: "task does not exist" });
          return cb(null, stored);
        }
        case "listTasks":
          return cb(null, { result: { tasks: [...tasks.values()].map((s) => s.task), nextPageToken: "", pageSize: 50, totalSize: tasks.size } });
        case "settleTask":
          if (!boundaries.has(`${req.taskId}@${req.version}`)) {
            refusedSettles += 1;
            return cb({ code: grpc.status.ABORTED, details: "task changed or the session cannot accept this update" });
          }
          return cb(null, {});
        default:
          return cb({ code: grpc.status.UNIMPLEMENTED, details: name });
      }
    };
  }
  const server = new grpc.Server();
  server.addService(definition, handlers);
  await new Promise<void>((resolve, reject) =>
    server.bindAsync(`${host}:${port}`, grpc.ServerCredentials.createInsecure(), (err) => (err ? reject(err) : resolve())),
  );
  return { calls, refusedSettles: () => refusedSettles, close: () => new Promise((r) => server.tryShutdown(() => r())) };
}

/** Serves POST /v1/chat/completions (streaming or not) with a fixed text reply. */
export async function startModelStub(host: string, port: number): Promise<ModelStub> {
  const requests: ModelRequest[] = [];
  const usage = { prompt_tokens: 3, completion_tokens: 5, total_tokens: 8 };
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      const authorization = req.headers.authorization;
      requests.push({ path: req.url ?? "", authorization, body });
      if (req.method !== "POST" || req.url !== "/v1/chat/completions") return void res.writeHead(404).end();
      const chunk = (delta: object, finish: string | null) =>
        `data: ${JSON.stringify({ id: "chatcmpl-check", object: "chat.completion.chunk", created: 1, model: "check-model", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
      if ((JSON.parse(body || "{}") as { stream?: boolean }).stream === true) {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(chunk({ role: "assistant", content: SCRIPTED_REPLY }, null));
        res.write(chunk({}, "stop"));
        res.write(`data: ${JSON.stringify({ id: "chatcmpl-check", object: "chat.completion.chunk", created: 1, model: "check-model", choices: [], usage })}\n\n`);
        return void res.end("data: [DONE]\n\n");
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          id: "chatcmpl-check",
          object: "chat.completion",
          created: 1,
          model: "check-model",
          choices: [{ index: 0, message: { role: "assistant", content: SCRIPTED_REPLY }, finish_reason: "stop" }],
          usage,
        }),
      );
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, resolve);
  });
  return { requests, close: () => new Promise((r) => { server.close(() => r()); server.closeAllConnections(); }) };
}
