import { mkdtempSync, readdirSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TaskState } from "@a2a-js/sdk";
import { afterEach, expect, it } from "vitest";
import { type FakeController, SESSION_ID, startFakeController } from "./fake-controller.ts";
import { type FakeModel, type RunningAgent, readyzStatus, startAgent, startFakeModel, waitFor, writeFakeConfig } from "./helpers.ts";
import { type Turn, sendTurn } from "./hitl-client.ts";
import { writeFileSync } from "node:fs";

const QUESTION = { questions: [{ question: "Which colour should the button be?", choices: ["red", "blue"], multiple: false }] };
const FINAL = "Done: the button is blue.";

let agent: RunningAgent | undefined;
let controller: FakeController | undefined;
let model: FakeModel | undefined;
afterEach(async () => {
  await agent?.stop();
  await controller?.close();
  await model?.close();
  agent = controller = model = undefined;
});

function identityFile(): string {
  const path = join(mkdtempSync(join(tmpdir(), "identity-")), "name");
  writeFileSync(path, `session-${SESSION_ID}\n`);
  return path;
}

async function boot(configPath: string, dataDir: string, identityPath: string): Promise<RunningAgent> {
  const running = await startAgent(configPath, { AGENT_DATA_DIR: dataDir, KAGENT_IDENTITY_PATH: identityPath });
  await waitFor(async () => (await readyzStatus(running.readyzPort)) === 200);
  return running;
}

async function turn(port: number, opts: Parameters<typeof sendTurn>[1]): Promise<Turn> {
  const got = await waitFor(async () => {
    try {
      return await sendTurn(port, opts);
    } catch {
      return null;
    }
  });
  if (!got) throw new Error("no reply from the agent");
  return got;
}

it("pauses with INPUT_REQUIRED and an ask_user_request", async () => {
  model = await startFakeModel([{ toolCall: { name: "ask_user", args: QUESTION } }, FINAL]);
  controller = await startFakeController();
  const dataDir = mkdtempSync(join(tmpdir(), "agent-data-"));
  agent = await boot(writeFakeConfig(model.baseUrl, { controlPlaneUrl: controller.url }), dataDir, identityFile());

  const paused = await turn(agent.grpcPort, { text: "Make the button a nicer colour" });

  expect(paused.kind).toBe("task");
  expect(paused.state).toBe(TaskState.TASK_STATE_INPUT_REQUIRED);
  expect(paused.request?.type).toBe("ask_user_request");
  expect(paused.request?.id).toBeTruthy();
  expect(paused.request?.questions).toEqual(QUESTION.questions);
  expect(paused.text).toContain("Which colour should the button be?");
  // The pending pause is saved as JSON under the data dir, per context.
  const file = join(dataDir, "sessions", paused.contextId, "state.json");
  expect(existsSync(file)).toBe(true);
  expect(JSON.parse(readFileSync(file, "utf8")).pending.requestId).toBe(paused.request?.id);
});

it("finishes after the agent process is killed and restarted between the question and the answer", async () => {
  model = await startFakeModel([{ toolCall: { name: "ask_user", args: QUESTION } }, FINAL]);
  controller = await startFakeController();
  const dataDir = mkdtempSync(join(tmpdir(), "agent-data-"));
  const configPath = writeFakeConfig(model.baseUrl, { controlPlaneUrl: controller.url });
  const identityPath = identityFile();
  agent = await boot(configPath, dataDir, identityPath);
  const paused = await turn(agent.grpcPort, { text: "Make the button a nicer colour" });
  expect(paused.state).toBe(TaskState.TASK_STATE_INPUT_REQUIRED);

  // A cold wake: the old process is gone, a new one starts on the same data dir.
  await agent.stop();
  agent = await boot(configPath, dataDir, identityPath);
  const done = await turn(agent.grpcPort, {
    text: "blue",
    taskId: paused.taskId,
    contextId: paused.contextId,
    answer: { id: paused.request!.id, answers: [["blue"]] },
  });

  expect(done.state).toBe(TaskState.TASK_STATE_COMPLETED);
  expect(done.taskId).toBe(paused.taskId);
  expect(done.text).toBe(FINAL);
  // The model saw the answer, as the result of its own ask_user call.
  expect(model.requests.at(-1)?.body).toContain("blue");
  // The pause is cleared once answered.
  const saved = JSON.parse(readFileSync(join(dataDir, "sessions", paused.contextId, "state.json"), "utf8"));
  expect(saved.pending).toBeUndefined();
  expect(readdirSync(join(dataDir, "sessions", paused.contextId))).toEqual(["state.json"]);
  // The answered turn joins the session's conversation.
  expect(JSON.stringify(saved.messages)).toContain(FINAL);
});

it("keeps its task in the controller, as a runtime caller, and settles each boundary", async () => {
  model = await startFakeModel([{ toolCall: { name: "ask_user", args: QUESTION } }, FINAL]);
  controller = await startFakeController();
  const dataDir = mkdtempSync(join(tmpdir(), "agent-data-"));
  agent = await boot(writeFakeConfig(model.baseUrl, { controlPlaneUrl: controller.url }), dataDir, identityFile());

  const paused = await turn(agent.grpcPort, { text: "Make the button a nicer colour" });
  const afterPause = controller.tasks.get(paused.taskId);
  expect(afterPause?.task.status?.state).toBe(TaskState.TASK_STATE_INPUT_REQUIRED);
  expect(controller.settled.at(-1)).toEqual({ taskId: paused.taskId, version: afterPause?.version });

  await turn(agent.grpcPort, {
    text: "blue",
    taskId: paused.taskId,
    contextId: paused.contextId,
    answer: { id: paused.request!.id, answers: [["blue"]] },
  });
  expect(controller.tasks.get(paused.taskId)?.task.status?.state).toBe(TaskState.TASK_STATE_COMPLETED);
  expect(controller.settled.at(-1)?.taskId).toBe(paused.taskId);
  expect(controller.calls.length).toBeGreaterThan(0);
  for (const c of controller.calls) expect(c.authorization).toBe("Bearer placeholder");
});

it("refuses an answer whose request id does not match the pending question", async () => {
  model = await startFakeModel([{ toolCall: { name: "ask_user", args: QUESTION } }, FINAL]);
  controller = await startFakeController();
  const dataDir = mkdtempSync(join(tmpdir(), "agent-data-"));
  agent = await boot(writeFakeConfig(model.baseUrl, { controlPlaneUrl: controller.url }), dataDir, identityFile());
  const paused = await turn(agent.grpcPort, { text: "Make the button a nicer colour" });

  const again = await turn(agent.grpcPort, {
    text: "blue",
    taskId: paused.taskId,
    contextId: paused.contextId,
    answer: { id: "not-the-pending-id", answers: [["blue"]] },
  });

  // Still paused on the same question; the model was not asked again.
  expect(again.state).toBe(TaskState.TASK_STATE_INPUT_REQUIRED);
  expect(again.request?.id).toBe(paused.request?.id);
  expect(model.requests).toHaveLength(1);
});
