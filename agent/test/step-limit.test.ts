import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TaskState } from "@a2a-js/sdk";
import { afterEach, expect, it } from "vitest";
import { type FakeModel, type RunningAgent, readyzStatus, sendTaskWhenUp, startAgent, startFakeModel, waitFor, writeFakeConfig } from "./helpers.ts";

let agent: RunningAgent | undefined;
let model: FakeModel | undefined;
afterEach(async () => {
  await agent?.stop();
  await model?.close();
  agent = model = undefined;
});

it("a model that never stops calling tools ends the turn at the step limit, and the reply says so", async () => {
  // The script's last entry repeats: this model calls read_file forever.
  model = await startFakeModel([{ toolCall: { name: "read_file", args: { path: "a.txt" } } }]);
  const dataDir = mkdtempSync(join(tmpdir(), "agent-data-"));
  agent = await startAgent(writeFakeConfig(model.baseUrl), { AGENT_DATA_DIR: dataDir, AGENT_MAX_STEPS: "4" });
  await waitFor(async () => (await readyzStatus(agent!.readyzPort)) === 200);

  const got = await sendTaskWhenUp(agent.grpcPort, "loop", { "a.txt": "hello\n" });

  expect(got.state).toBe(TaskState.TASK_STATE_COMPLETED);
  expect(model.requests).toHaveLength(4);
  expect(got.artifacts.reply).toMatch(/step limit \(4 steps\) was reached/i);
});
