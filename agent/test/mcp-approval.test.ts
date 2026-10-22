import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TaskState } from "@a2a-js/sdk";
import { afterEach, expect, it } from "vitest";
import { type FakeController, SESSION_ID, startFakeController } from "./fake-controller.ts";
import { type FakeMcp, startFakeMcp } from "./fake-mcp.ts";
import { type FakeModel, type RunningAgent, readyzStatus, type ScriptedReply, startAgent, startFakeModel, toolResults, waitFor, writeFakeConfig } from "./helpers.ts";
import { sendTurn, type Turn } from "./hitl-client.ts";

let agent: RunningAgent | undefined;
let controller: FakeController | undefined;
let model: FakeModel | undefined;
let mcp: FakeMcp | undefined;
afterEach(async () => {
  await agent?.stop();
  await controller?.close();
  await model?.close();
  await mcp?.close();
  agent = controller = model = mcp = undefined;
});

const DELETE = { name: "delete_branch", description: "Delete a git branch on the remote", result: "deleted branch feature-x" };
const deleteBranch: ScriptedReply = { toolCall: { name: "delete_branch", args: { branch: "feature-x" } } };

const savedState = (dataDir: string, contextId: string): { pending?: { kind?: string } } =>
  JSON.parse(readFileSync(join(dataDir, "sessions", contextId, "state.json"), "utf8"));

/** Starts the agent with one MCP binding (the fake server's delete_branch), on a fresh data dir. */
async function boot(script: ScriptedReply[], requireApproval: boolean) {
  model = await startFakeModel(script);
  controller = await startFakeController();
  mcp = await startFakeMcp([DELETE]);
  const dataDir = mkdtempSync(join(tmpdir(), "agent-data-"));
  const identity = join(mkdtempSync(join(tmpdir(), "identity-")), "name");
  writeFileSync(identity, `session-${SESSION_ID}\n`);
  const httpTools = [{ params: { url: mcp.url, headers: {} }, tools: [DELETE.name], require_approval: requireApproval }];
  const configPath = writeFakeConfig(model.baseUrl, { controlPlaneUrl: controller.url, httpTools });
  const start = async () => {
    agent = await startAgent(configPath, { AGENT_DATA_DIR: dataDir, KAGENT_IDENTITY_PATH: identity });
    await waitFor(async () => (await readyzStatus(agent!.readyzPort)) === 200);
  };
  await start();
  return {
    dataDir,
    contextId: `ctx-${crypto.randomUUID()}`,
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

it("a tool on a requireApproval binding pauses with a tool_approval_request and the MCP server gets no call", async () => {
  const { contextId, dataDir } = await boot([deleteBranch, "Deleted."], true);

  const paused = await turn({ text: "delete the feature-x branch", contextId });

  expect(paused.state).toBe(TaskState.TASK_STATE_INPUT_REQUIRED);
  const tools = paused.approvalRequest?.tools ?? [];
  expect(tools).toHaveLength(1);
  expect(tools[0]?.name).toBe("delete_branch");
  expect(tools[0]?.args).toEqual({ branch: "feature-x" });
  expect(paused.approvalRequest?.hint).toContain("(delete_branch)");
  expect(mcp!.calls).toEqual([]);
  expect(model!.requests).toHaveLength(1);
  expect(savedState(dataDir, contextId).pending?.kind).toBe("tool_approval");
});

it("a tool on a binding without requireApproval runs with no pause", async () => {
  const { contextId } = await boot([deleteBranch, "Deleted."], false);

  const done = await turn({ text: "delete the feature-x branch", contextId });

  expect(done.state).toBe(TaskState.TASK_STATE_COMPLETED);
  expect(done.approvalRequest).toBeUndefined();
  expect(mcp!.calls).toEqual([{ name: "delete_branch", args: { branch: "feature-x" } }]);
  expect(toolResults(model!).at(-1)).toContain("deleted branch feature-x");
});

it("approve runs the MCP call once, after a cold restart between the pause and the answer", async () => {
  const booted = await boot([deleteBranch, "Deleted feature-x.", deleteBranch, "Deleted again."], true);
  const { contextId } = booted;
  const paused = await turn({ text: "delete the feature-x branch", contextId });
  const id = paused.approvalRequest!.tools[0]!.id;

  await booted.restart();
  const done = await turn({ text: "approve", taskId: paused.taskId, contextId, approvals: [{ id, approved: true }] });

  expect(done.state).toBe(TaskState.TASK_STATE_COMPLETED);
  expect(done.text).toContain("Deleted feature-x.");
  expect(mcp!.calls).toEqual([{ name: "delete_branch", args: { branch: "feature-x" } }]);
  expect(toolResults(model!).at(-1)).toContain("deleted branch feature-x");

  // The approval was for that call only: the next call pauses again.
  const again = await turn({ text: "delete it again", contextId });
  expect(again.state).toBe(TaskState.TASK_STATE_INPUT_REQUIRED);
  expect(mcp!.calls).toHaveLength(1);
});

it("deny with a reason: the MCP server gets no call and the reason reaches the model", async () => {
  const { contextId, dataDir } = await boot([deleteBranch, "I kept feature-x: it has open work."], true);
  const paused = await turn({ text: "delete the feature-x branch", contextId });
  const id = paused.approvalRequest!.tools[0]!.id;

  const done = await turn({ text: "deny", taskId: paused.taskId, contextId, approvals: [{ id, approved: false, rejection_reason: "it has open work" }] });

  expect(done.state).toBe(TaskState.TASK_STATE_COMPLETED);
  expect(done.text).toContain("open work");
  expect(mcp!.calls).toEqual([]);
  const results = toolResults(model!);
  expect(results).toHaveLength(1);
  expect(results[0]).toContain("it has open work");
  expect(results[0]).toMatch(/denied/i);
  expect(savedState(dataDir, contextId).pending).toBeUndefined();
});

it("an answer that does not decide the pending MCP call keeps it paused and uncalled", async () => {
  const { contextId } = await boot([deleteBranch, "Deleted."], true);
  const paused = await turn({ text: "delete the feature-x branch", contextId });

  const wrongId = await turn({ text: "approve", taskId: paused.taskId, contextId, approvals: [{ id: "not-the-pending-id", approved: true }] });
  const plainText = await turn({ text: "yes, go ahead", taskId: paused.taskId, contextId });

  for (const got of [wrongId, plainText]) {
    expect(got.state).toBe(TaskState.TASK_STATE_INPUT_REQUIRED);
    expect(got.approvalRequest?.tools[0]?.id).toBe(paused.approvalRequest?.tools[0]?.id);
  }
  expect(mcp!.calls).toEqual([]);
  expect(model!.requests).toHaveLength(1);
});
