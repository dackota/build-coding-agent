import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Role, TaskState } from "@a2a-js/sdk";
import { ServerCallContext } from "@a2a-js/sdk/server";
import { afterEach, expect, it } from "vitest";
import { ControllerTaskStore } from "../src/controller-task-store.ts";
import type { Task } from "../src/wire.ts";
import { type FakeController, SESSION_ID, startFakeController } from "./fake-controller.ts";

let controller: FakeController | undefined;
afterEach(async () => {
  await controller?.close();
  controller = undefined;
});

const CONTEXT_ID = "9f1c2d3e-0000-4000-8000-000000000001";

function task(state: TaskState, id = "task-1"): Task {
  return {
    id,
    contextId: CONTEXT_ID,
    status: { state, message: undefined, timestamp: undefined },
    artifacts: [],
    history: [
      { messageId: "m-1", contextId: CONTEXT_ID, taskId: id, role: Role.ROLE_USER, parts: [], metadata: undefined, extensions: [], referenceTaskIds: [] },
    ],
    metadata: undefined,
  };
}

function ctx(headers: Record<string, string> = {}): ServerCallContext {
  return new ServerCallContext({ state: new Map([["headers", headers]]) });
}

async function makeStore(c: FakeController, identity = `session-${SESSION_ID}\n`): Promise<ControllerTaskStore> {
  const identityPath = join(mkdtempSync(join(tmpdir(), "identity-")), "name");
  writeFileSync(identityPath, identity);
  return new ControllerTaskStore({ controlPlaneUrl: c.url, identityPath });
}

it("creates a task on its first save and updates it with the version the controller returned", async () => {
  controller = await startFakeController();
  const store = await makeStore(controller);

  await store.save(task(TaskState.TASK_STATE_WORKING), ctx());
  await store.save(task(TaskState.TASK_STATE_WORKING), ctx());

  expect(controller.calls.map((c) => c.method)).toEqual(["createTask", "updateTask"]);
  expect(controller.calls[0]?.request.sessionId).toBe(SESSION_ID);
  expect(controller.calls[1]?.request.expectedVersion).toBe(1);
  expect(controller.tasks.get("task-1")?.version).toBe(2);
});

it("sends the Bearer placeholder that Substrate replaces with the Actor JWT", async () => {
  controller = await startFakeController();
  const store = await makeStore(controller);
  await store.save(task(TaskState.TASK_STATE_WORKING), ctx());
  expect(controller.calls[0]?.authorization).toBe("Bearer placeholder");
});

it("passes the gateway's dispatch id on to every save", async () => {
  controller = await startFakeController();
  const store = await makeStore(controller);
  const dispatch = "7d2b0f64-0000-4000-8000-00000000abcd";
  await store.save(task(TaskState.TASK_STATE_WORKING), ctx({ "x-kagent-dispatch-id": dispatch }));
  await store.save(task(TaskState.TASK_STATE_WORKING), ctx({ "x-kagent-dispatch-id": dispatch }));
  expect(controller.calls.map((c) => c.request.dispatchId)).toEqual([dispatch, dispatch]);
});

it("settles the saved version after a save that ends in a boundary state, and only then", async () => {
  controller = await startFakeController();
  const store = await makeStore(controller);

  await store.save(task(TaskState.TASK_STATE_WORKING), ctx());
  expect(controller.settled).toEqual([]);
  await store.save(task(TaskState.TASK_STATE_INPUT_REQUIRED), ctx());
  expect(controller.settled).toEqual([{ taskId: "task-1", version: 2 }]);

  await store.save(task(TaskState.TASK_STATE_COMPLETED, "task-2"), ctx());
  expect(controller.settled.at(-1)).toEqual({ taskId: "task-2", version: 1 });
});

it("does not settle a save that leaves an input-required task in the same state (the SDK saves the user's reply that way)", async () => {
  controller = await startFakeController();
  const store = await makeStore(controller);
  await store.save(task(TaskState.TASK_STATE_WORKING), ctx());
  await store.save(task(TaskState.TASK_STATE_INPUT_REQUIRED), ctx());
  expect(controller.settled).toEqual([{ taskId: "task-1", version: 2 }]);

  // The answer arrives: the SDK stores it in the history first, state unchanged.
  await store.save(task(TaskState.TASK_STATE_INPUT_REQUIRED), ctx());
  expect(controller.settled).toHaveLength(1);
  // The agent resumes and finishes: a real boundary again.
  await store.save(task(TaskState.TASK_STATE_WORKING), ctx());
  await store.save(task(TaskState.TASK_STATE_COMPLETED), ctx());
  expect(controller.settled.at(-1)).toEqual({ taskId: "task-1", version: 5 });
});

it("loads a task from the controller and keeps its version, so a restarted agent can update it", async () => {
  controller = await startFakeController();
  const first = await makeStore(controller);
  await first.save(task(TaskState.TASK_STATE_WORKING), ctx());
  await first.save(task(TaskState.TASK_STATE_INPUT_REQUIRED), ctx());

  const restarted = await makeStore(controller);
  const loaded = await restarted.load("task-1", ctx());
  expect(loaded?.status?.state).toBe(TaskState.TASK_STATE_INPUT_REQUIRED);
  await restarted.save(task(TaskState.TASK_STATE_WORKING), ctx());

  expect(controller.calls.at(-1)?.method).toBe("updateTask");
  expect(controller.calls.at(-1)?.request.expectedVersion).toBe(2);
});

it("returns undefined for a task the controller does not know", async () => {
  controller = await startFakeController();
  const store = await makeStore(controller);
  expect(await store.load("nope", ctx())).toBeUndefined();
});

it("lists the session's tasks", async () => {
  controller = await startFakeController();
  const store = await makeStore(controller);
  await store.save(task(TaskState.TASK_STATE_WORKING), ctx());
  const listed = await store.list({ tenant: "", contextId: "", status: 0, pageSize: undefined, pageToken: "", historyLength: undefined, statusTimestampAfter: undefined, includeArtifacts: false }, ctx());
  expect(listed.tasks.map((t) => t.id)).toEqual(["task-1"]);
});

it("fails with the controller's message when the caller is not a runtime actor", async () => {
  controller = await startFakeController();
  const store = new ControllerTaskStore({
    controlPlaneUrl: controller.url,
    identityPath: await (async () => {
      const p = join(mkdtempSync(join(tmpdir(), "identity-")), "name");
      writeFileSync(p, "session-00000000-0000-4000-8000-000000000000");
      return p;
    })(),
  });
  await expect(store.save(task(TaskState.TASK_STATE_WORKING), ctx())).rejects.toThrow(/actor does not belong/);
});

it("rejects an identity file that is not a session actor name", async () => {
  controller = await startFakeController();
  const store = await makeStore(controller, "not-a-session");
  await expect(store.save(task(TaskState.TASK_STATE_WORKING), ctx())).rejects.toThrow(/identity/i);
});
