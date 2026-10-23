import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { TaskState } from "@a2a-js/sdk";
import { afterEach, expect, it } from "vitest";
import { type FakeController, SESSION_ID, startFakeController } from "./fake-controller.ts";
import { type FakeModel, type RunningAgent, readyzStatus, type ScriptedReply, startAgent, startFakeModel, waitFor, writeFakeConfig } from "./helpers.ts";
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

const watchDir = fileURLToPath(new URL("./fixtures/ext-watch", import.meta.url));
const bash = (command: string): ScriptedReply => ({ toolCall: { name: "bash", args: { command } } });
/** The tools the ext-watch fixture's tool_call handler has seen, in order. */
const seen = (): string[] =>
  agent!
    .output()
    .split("\n")
    .filter((l) => l.includes('"event":"fixture-seen"'))
    .map((l) => (JSON.parse(l) as { tool: string }).tool);

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

it("an approval pause comes before tool_call; after approve the handler sees the call once", async () => {
  model = await startFakeModel([bash("rm a.txt"), "Removed."]);
  controller = await startFakeController();
  const dataDir = mkdtempSync(join(tmpdir(), "agent-data-"));
  const identity = join(mkdtempSync(join(tmpdir(), "identity-")), "name");
  writeFileSync(identity, `session-${SESSION_ID}\n`);
  agent = await startAgent(writeFakeConfig(model.baseUrl, { controlPlaneUrl: controller.url }), {
    AGENT_DATA_DIR: dataDir,
    KAGENT_IDENTITY_PATH: identity,
    AGENT_EXTENSIONS_DIR: watchDir,
  });
  await waitFor(async () => (await readyzStatus(agent!.readyzPort)) === 200);
  const contextId = `ctx-${crypto.randomUUID()}`;
  const ws = join(dataDir, "workspaces", contextId);
  mkdirSync(ws, { recursive: true });
  writeFileSync(join(ws, "a.txt"), "hello\n");

  const paused = await turn({ text: "remove a.txt", contextId });
  expect(paused.state).toBe(TaskState.TASK_STATE_INPUT_REQUIRED);
  expect(paused.approvalRequest?.tools[0]?.args).toEqual({ command: "rm a.txt" });
  expect(seen()).toEqual([]);

  expect(existsSync(join(ws, "a.txt"))).toBe(true);
  const id = paused.approvalRequest!.tools[0]!.id;
  const done = await turn({ text: "approve", taskId: paused.taskId, contextId, approvals: [{ id, approved: true }] });

  expect(done.state).toBe(TaskState.TASK_STATE_COMPLETED);
  expect(seen()).toEqual(["bash"]);
  expect(existsSync(join(ws, "a.txt"))).toBe(false);
});
