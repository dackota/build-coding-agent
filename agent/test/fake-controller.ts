import * as grpc from "@grpc/grpc-js";
import type { StubCall, StoredTask } from "../src/byo-check/stubs.ts";
import { startControllerStub, taskStoreServiceDefinition } from "../src/byo-check/stubs.ts";
import { taskStoreMethods, type Task } from "../src/wire.ts";

export const SESSION_ID = "11111111-2222-4333-8444-555555555555";

export type ControllerCall = StubCall;

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
 * Stands in for kagent's private TaskStoreService: the byo-check stub, the one copy of what
 * the real controller enforces (a runtime caller, versioned updates, no updates to a terminal
 * task), on a free port.
 */
export async function startFakeController(): Promise<FakeController> {
  const stub = await startControllerStub("127.0.0.1", 0, SESSION_ID);
  const tasks: Map<string, StoredTask> = stub.tasks;
  return { address: `127.0.0.1:${stub.port}`, url: `http://127.0.0.1:${stub.port}`, calls: stub.calls, tasks, settled: stub.settled, boundaries: stub.boundaries, close: stub.close };
}

export type EgressProxy = {
  url: string;
  /** While down, every call gets UNAVAILABLE at once over a connection that stays READY. */
  setDown: (down: boolean) => void;
  refused: () => number;
  close: () => Promise<void>;
};

/** Substrate's egress proxy in front of the fake controller; down, it answers like it does during a controller restart. */
export async function startEgressProxy(controller: FakeController): Promise<EgressProxy> {
  const upstream = new grpc.Client(controller.address, grpc.credentials.createInsecure());
  let down = false;
  let refused = 0;
  const handlers: grpc.UntypedServiceImplementation = {};
  for (const [name, m] of Object.entries(taskStoreMethods)) {
    handlers[name] = (call: grpc.ServerUnaryCall<unknown, unknown>, cb: grpc.sendUnaryData<unknown>) => {
      if (down) {
        refused += 1;
        return cb({ code: grpc.status.UNAVAILABLE, details: "upstream call failed: Connect: Connection refused" });
      }
      upstream.makeUnaryRequest(m.path, (v: unknown) => m.request.encode(v as never), (b: Buffer) => m.response.decode(b), call.request, call.metadata, cb);
    };
  }
  const server = new grpc.Server();
  server.addService(taskStoreServiceDefinition(), handlers);
  const port = await new Promise<number>((resolve, reject) =>
    server.bindAsync("127.0.0.1:0", grpc.ServerCredentials.createInsecure(), (err, p) => (err ? reject(err) : resolve(p))),
  );
  return {
    url: `http://127.0.0.1:${port}`,
    setDown: (d) => {
      down = d;
    },
    refused: () => refused,
    close: async () => {
      upstream.close();
      await new Promise<void>((r) => server.tryShutdown(() => r()));
    },
  };
}
