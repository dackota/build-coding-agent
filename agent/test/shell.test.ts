import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TaskState } from "@a2a-js/sdk";
import { afterEach, expect, it } from "vitest";
import { type FakeController, SESSION_ID, startFakeController } from "./fake-controller.ts";
import { type FakeModel, type RunningAgent, readyzStatus, type ScriptedReply, startAgent, startFakeModel, toolResults, waitFor, writeFakeConfig } from "./helpers.ts";
import { sendTurn, type Turn } from "./hitl-client.ts";

let agent: RunningAgent | undefined;
let controller: FakeController | undefined;
let model: FakeModel | undefined;
afterEach(async () => {
  await agent?.stop();
  await controller?.close();
  await model?.close();
  agent = controller = model = undefined;
});

const bash = (command: string): ScriptedReply => ({ toolCall: { name: "bash", args: { command } } });

/** The session state the agent saved for a context. */
const savedState = (dataDir: string, contextId: string): { pending?: { kind?: string }; approvedKinds?: string[] } =>
  JSON.parse(readFileSync(join(dataDir, "sessions", contextId, "state.json"), "utf8"));

type Booted ={ dataDir: string; contextId: string; ws: string; restart: () => Promise<void> };

/** Starts the agent on a fresh data dir, with a workspace for one context seeded with build/ and dist/. */
async function boot(script: ScriptedReply[]): Promise<Booted> {
  model = await startFakeModel(script);
  controller = await startFakeController();
  const dataDir = mkdtempSync(join(tmpdir(), "agent-data-"));
  const identity = join(mkdtempSync(join(tmpdir(), "identity-")), "name");
  writeFileSync(identity, `session-${SESSION_ID}\n`);
  const configPath = writeFakeConfig(model.baseUrl, { controlPlaneUrl: controller.url });
  const start = async () => {
    agent = await startAgent(configPath, { AGENT_DATA_DIR: dataDir, KAGENT_IDENTITY_PATH: identity });
    await waitFor(async () => (await readyzStatus(agent!.readyzPort)) === 200);
  };
  await start();
  const contextId = `ctx-${crypto.randomUUID()}`;
  const ws = join(dataDir, "workspaces", contextId);
  for (const dir of ["build", "dist"]) {
    mkdirSync(join(ws, dir), { recursive: true });
    writeFileSync(join(ws, dir, "out.txt"), "artifact\n");
  }
  writeFileSync(join(ws, "a.txt"), "hello\n");
  return {
    dataDir,
    contextId,
    ws,
    restart: async () => {
      await agent!.stop();
      await start();
    },
  };
}

async function turn(opts: Parameters<typeof sendTurn>[1]): Promise<Turn> {
  const got = await waitFor(async () => {
    try {
      return await sendTurn(agent!.grpcPort, opts);
    } catch {
      return null;
    }
  });
  if (!got) throw new Error("no reply from the agent");
  return got;
}

it("a safe command (ls) runs with no pause and its output reaches the model", async () => {
  const { contextId } = await boot([bash("ls"), "Listed."]);

  const got = await turn({ text: "list the files", contextId });

  expect(got.state).toBe(TaskState.TASK_STATE_COMPLETED);
  expect(got.approvalRequest).toBeUndefined();
  expect(got.text).toContain("Listed.");
  expect(toolResults(model!)[0]).toContain("a.txt");
});

it("a risky command pauses with a tool_approval_request and does not run", async () => {
  const { contextId, ws, dataDir } = await boot([bash("rm -rf build"), "Removed."]);

  const paused = await turn({ text: "clean the build", contextId });

  expect(paused.state).toBe(TaskState.TASK_STATE_INPUT_REQUIRED);
  const tools = paused.approvalRequest?.tools ?? [];
  expect(tools).toHaveLength(1);
  expect(tools[0]?.name).toBe("bash");
  expect(tools[0]?.args).toEqual({ command: "rm -rf build" });
  expect(tools[0]?.id).toBeTruthy();
  expect(paused.approvalRequest?.hint).toContain("(bash)");
  expect(paused.text).toContain("(bash)");
  expect(existsSync(join(ws, "build", "out.txt"))).toBe(true);
  expect(model!.requests).toHaveLength(1);
  // The pending approval is saved under the data dir, so a cold start can finish it.
  const { pending } = savedState(dataDir, contextId);
  expect(pending?.kind).toBe("tool_approval");
  expect(JSON.stringify(pending)).toContain(tools[0]!.id);
});

it("a safe command chained to a risky one pauses", async () => {
  const { contextId, ws } = await boot([bash("ls && rm -rf build"), "Removed."]);

  const paused = await turn({ text: "clean the build", contextId });

  expect(paused.state).toBe(TaskState.TASK_STATE_INPUT_REQUIRED);
  expect(paused.approvalRequest?.tools[0]?.args).toEqual({ command: "ls && rm -rf build" });
  expect(existsSync(join(ws, "build"))).toBe(true);
});

it("approve runs the paused command once; the next risky command pauses again", async () => {
  const { contextId, ws } = await boot([bash("rm -rf build"), "Removed build.", bash("rm -rf dist"), "Removed dist."]);
  const paused = await turn({ text: "clean the build", contextId });
  const id = paused.approvalRequest!.tools[0]!.id;

  const done = await turn({ text: "approve", taskId: paused.taskId, contextId, approvals: [{ id, approved: true }] });

  expect(done.state).toBe(TaskState.TASK_STATE_COMPLETED);
  expect(done.taskId).toBe(paused.taskId);
  expect(done.text).toContain("Removed build.");
  expect(existsSync(join(ws, "build"))).toBe(false);
  expect(toolResults(model!).at(-1)).toContain("exit code: 0");

  const again = await turn({ text: "clean dist", contextId });
  expect(again.state).toBe(TaskState.TASK_STATE_INPUT_REQUIRED);
  expect(again.approvalRequest?.tools[0]?.args).toEqual({ command: "rm -rf dist" });
  expect(existsSync(join(ws, "dist"))).toBe(true);
});

it("deny with a reason: the command does not run and the reason reaches the model", async () => {
  const { contextId, ws, dataDir } = await boot([bash("rm -rf build"), "I left build alone: keep build."]);
  const paused = await turn({ text: "clean the build", contextId });
  const id = paused.approvalRequest!.tools[0]!.id;

  const done = await turn({ text: "deny", taskId: paused.taskId, contextId, approvals: [{ id, approved: false, rejection_reason: "keep build" }] });

  expect(done.state).toBe(TaskState.TASK_STATE_COMPLETED);
  expect(done.text).toContain("keep build");
  expect(existsSync(join(ws, "build", "out.txt"))).toBe(true);
  expect(model!.requests).toHaveLength(2);
  const results = toolResults(model!);
  expect(results).toHaveLength(1);
  expect(results[0]).toContain("keep build");
  expect(results[0]).toMatch(/denied/i);
  expect(savedState(dataDir, contextId).pending).toBeUndefined();
});

it("approve for this session: a later command of the same kind runs with no pause, after a restart too", async () => {
  const booted = await boot([bash("rm -rf build"), "Removed build.", bash("rm -rf dist"), "Removed dist.", bash("mv a.txt b.txt"), "Moved."]);
  const { contextId, ws, dataDir } = booted;
  const paused = await turn({ text: "clean the build", contextId });
  const id = paused.approvalRequest!.tools[0]!.id;

  const first = await turn({ text: "approve for this session", taskId: paused.taskId, contextId, approvals: [{ id, approved: true, scope: "session" }] });
  expect(first.state).toBe(TaskState.TASK_STATE_COMPLETED);
  expect(existsSync(join(ws, "build"))).toBe(false);
  // The session approval is saved under the data dir.
  expect(savedState(dataDir, contextId).approvedKinds).toEqual(["rm"]);

  // A cold wake between the turns: the session approval survives it.
  await booted.restart();
  const second = await turn({ text: "clean dist", contextId });
  expect(second.state).toBe(TaskState.TASK_STATE_COMPLETED);
  expect(second.approvalRequest).toBeUndefined();
  expect(second.text).toContain("Removed dist.");
  expect(existsSync(join(ws, "dist"))).toBe(false);

  // Another kind of risky command still pauses.
  const third = await turn({ text: "rename a.txt", contextId });
  expect(third.state).toBe(TaskState.TASK_STATE_INPUT_REQUIRED);
  expect(third.approvalRequest?.tools[0]?.args).toEqual({ command: "mv a.txt b.txt" });
  expect(existsSync(join(ws, "a.txt"))).toBe(true);
});

it("an answer that does not decide the pending call keeps the task paused", async () => {
  const { contextId, ws } = await boot([bash("rm -rf build"), "Removed."]);
  const paused = await turn({ text: "clean the build", contextId });

  const wrongId = await turn({ text: "approve", taskId: paused.taskId, contextId, approvals: [{ id: "not-the-pending-id", approved: true }] });
  const plainText = await turn({ text: "yes, go ahead", taskId: paused.taskId, contextId });

  for (const got of [wrongId, plainText]) {
    expect(got.state).toBe(TaskState.TASK_STATE_INPUT_REQUIRED);
    expect(got.approvalRequest?.tools[0]?.id).toBe(paused.approvalRequest?.tools[0]?.id);
  }
  expect(model!.requests).toHaveLength(1);
  expect(existsSync(join(ws, "build", "out.txt"))).toBe(true);
});
