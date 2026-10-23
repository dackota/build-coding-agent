import * as grpc from "@grpc/grpc-js";
import { taskStoreMethods } from "../src/wire.ts";
import type { Task } from "../src/wire.ts";

export const SESSION_ID = "11111111-2222-4333-8444-555555555555";
const TERMINAL = new Set([3, 4, 5, 7]);
const INTERRUPTED = new Set([6, 8]);

export type ControllerCall = {
  method: string;
  authorization: string | undefined;
  request: Record<string, unknown>;
};

export type FakeController = {
  address: string;
  url: string;
  calls: ControllerCall[];
  tasks: Map<string, { task: Task; version: number }>;
  settled: { taskId: string; version: number }[];
  /** Versions the real controller treats as boundaries: terminal, or a move into a waiting state. */
  boundaries: Set<string>;
  close: () => Promise<void>;
};

/**
 * Stands in for kagent's private TaskStoreService. It keeps what the real one enforces:
 * a runtime caller (Bearer placeholder here, where Substrate would inject the Actor JWT),
 * versioned updates, and no updates to a terminal task.
 */
export async function startFakeController(): Promise<FakeController> {
  const state: FakeController = { address: "", url: "", calls: [], tasks: new Map(), settled: [], boundaries: new Set(), close: async () => {} };
  const server = new grpc.Server();
  const handlers: grpc.UntypedServiceImplementation = {};
  const definition: Record<string, grpc.MethodDefinition<unknown, unknown>> = {};
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
      state.calls.push({ method: name, authorization, request: call.request });
      if (authorization !== "Bearer placeholder") {
        return cb({ code: grpc.status.PERMISSION_DENIED, details: "runtime actor identity is required" });
      }
      const req = call.request;
      if (req.sessionId !== SESSION_ID) return cb({ code: grpc.status.PERMISSION_DENIED, details: "actor does not belong to this session" });
      switch (name) {
        case "createTask": {
          if (state.tasks.has(req.task.id)) return cb({ code: grpc.status.ALREADY_EXISTS, details: "task ID already exists" });
          state.tasks.set(req.task.id, { task: req.task, version: 1 });
          if (TERMINAL.has(req.task.status?.state ?? 0) || INTERRUPTED.has(req.task.status?.state ?? 0)) state.boundaries.add(`${req.task.id}@1`);
          return cb(null, { version: 1 });
        }
        case "updateTask": {
          const stored = state.tasks.get(req.task.id);
          if (!stored) return cb({ code: grpc.status.NOT_FOUND, details: "task does not exist" });
          if (stored.version !== req.expectedVersion) return cb({ code: grpc.status.ABORTED, details: "task changed" });
          if (TERMINAL.has(stored.task.status?.state ?? 0)) return cb({ code: grpc.status.FAILED_PRECONDITION, details: "terminal task" });
          const next = req.task.status?.state ?? 0;
          const isBoundary = TERMINAL.has(next) || (INTERRUPTED.has(next) && stored.task.status?.state !== next);
          stored.task = req.task;
          stored.version += 1;
          if (isBoundary) state.boundaries.add(`${req.task.id}@${stored.version}`);
          return cb(null, { version: stored.version });
        }
        case "getTask": {
          const stored = state.tasks.get(req.taskId);
          if (!stored) return cb({ code: grpc.status.NOT_FOUND, details: "task does not exist" });
          return cb(null, stored);
        }
        case "listTasks":
          return cb(null, {
            result: { tasks: [...state.tasks.values()].map((s) => s.task), nextPageToken: "", pageSize: 50, totalSize: state.tasks.size },
          });
        case "settleTask":
          if (!state.boundaries.has(`${req.taskId}@${req.version}`)) {
            return cb({ code: grpc.status.ABORTED, details: "task changed or the session cannot accept this update" });
          }
          state.settled.push({ taskId: req.taskId, version: req.version });
          return cb(null, {});
        default:
          return cb({ code: grpc.status.UNIMPLEMENTED, details: name });
      }
    };
  }
  server.addService(definition, handlers);
  const port = await new Promise<number>((resolve, reject) =>
    server.bindAsync("127.0.0.1:0", grpc.ServerCredentials.createInsecure(), (err, p) => (err ? reject(err) : resolve(p))),
  );
  state.address = `127.0.0.1:${port}`;
  state.url = `http://127.0.0.1:${port}`;
  state.close = () => new Promise((r) => server.tryShutdown(() => r()));
  return state;
}
