import { mkdtempSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TaskState } from "@a2a-js/sdk";
import { afterEach, expect, it } from "vitest";
import { cancelTask, type FakeModel, readyzStatus, type RunningAgent, sendTask, startAgent, startFakeModel, streamMessage, waitFor, writeFakeConfig } from "./helpers.ts";

let agent: RunningAgent | undefined;
let model: FakeModel | undefined;
afterEach(async () => {
  await agent?.stop();
  await model?.close();
  agent = model = undefined;
});

it("CancelTask mid-turn ends the task canceled and the session continues on the same context", async () => {
  model = await startFakeModel([{ toolCall: { name: "list_files", args: {} } }, { hang: true }, "Back again."]);
  const dataDir = mkdtempSync(join(tmpdir(), "agent-data-"));
  agent = await startAgent(writeFakeConfig(model.baseUrl), { AGENT_SANDBOX: "memory", AGENT_DATA_DIR: dataDir });
  await waitFor(async () => (await readyzStatus(agent!.readyzPort)) === 200);

  let ids: { taskId: string; contextId: string } | undefined;
  let canceledState: number | undefined;
  const events = await streamMessage(agent.grpcPort, "list then wait", {
    onEvent: async (e) => {
      if (e.event?.type === "tool_call" && !ids) {
        ids = { taskId: e.taskId!, contextId: e.contextId! };
        // The model is now hanging on its second call: the user presses Ctrl-C.
        await waitFor(async () => (model!.requests.length >= 2 ? true : null));
        canceledState = await cancelTask(agent!.grpcPort, ids.taskId);
      }
    },
  });

  expect(canceledState).toBe(TaskState.TASK_STATE_CANCELED);
  expect(events.at(-1)?.state).toBe(TaskState.TASK_STATE_CANCELED);
  // The finished step is on disk, and nothing half-written.
  const file = join(dataDir, "sessions", ids!.contextId, "state.json");
  expect(existsSync(file)).toBe(true);
  expect(JSON.parse(readFileSync(file, "utf8")).pending).toBeUndefined();

  const next = await sendTask(agent.grpcPort, "carry on", {}, ids!.contextId);
  expect(next.state).toBe(TaskState.TASK_STATE_COMPLETED);
  expect(next.contextId).toBe(ids!.contextId);
  expect(next.artifacts.reply).toBe("Back again.");
});
