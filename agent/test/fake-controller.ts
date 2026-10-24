import type { StubCall, StoredTask } from "../src/byo-check/stubs.ts";
import { startControllerStub } from "../src/byo-check/stubs.ts";
import type { Task } from "../src/wire.ts";

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
