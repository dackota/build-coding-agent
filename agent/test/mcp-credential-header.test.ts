// Seam 1 for a Secret-backed RemoteMCPServer header: kagent writes __KAGENT_ENV[NAME]__ into
// the config and puts NAME in the actor's env (the placeholder the egress gateway swaps for
// the Secret). The agent must send the variable's value, not the token, on every MCP request.
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TaskState } from "@a2a-js/sdk";
import { afterEach, expect, it } from "vitest";
import { type FakeController, SESSION_ID, startFakeController } from "./fake-controller.ts";
import { type FakeMcp, startFakeMcp } from "./fake-mcp.ts";
import { type FakeModel, type RunningAgent, readyzStatus, startAgent, startFakeModel, waitFor, writeFakeConfig } from "./helpers.ts";
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
const CREDENTIAL_VAR = "KAGENT_CREDENTIAL_0123456789ABCDEF";
const PLACEHOLDER = "kagent-credential-injected";

it("the MCP server gets the header with the variable's value on a tool call", async () => {
  model = await startFakeModel([{ toolCall: { name: DELETE.name, args: { branch: "feature-x" } } }, "Deleted."]);
  controller = await startFakeController();
  mcp = await startFakeMcp([DELETE]);
  const identity = join(mkdtempSync(join(tmpdir(), "identity-")), "name");
  writeFileSync(identity, `session-${SESSION_ID}\n`);
  const httpTools = [{ params: { url: mcp.url, headers: { Authorization: `__KAGENT_ENV[${CREDENTIAL_VAR}]__` } }, tools: [DELETE.name] }];
  const configPath = writeFakeConfig(model.baseUrl, { controlPlaneUrl: controller.url, httpTools });
  agent = await startAgent(configPath, { KAGENT_IDENTITY_PATH: identity, [CREDENTIAL_VAR]: PLACEHOLDER });
  await waitFor(async () => (await readyzStatus(agent!.readyzPort)) === 200);

  const done = await waitFor<Turn>(async () => {
    try {
      return await sendTurn(agent!.grpcPort, { text: "delete the feature-x branch", contextId: `ctx-${crypto.randomUUID()}` });
    } catch {
      return null;
    }
  });

  expect(done?.state).toBe(TaskState.TASK_STATE_COMPLETED);
  expect(mcp.calls).toEqual([{ name: DELETE.name, args: { branch: "feature-x" } }]);
  const toolCalls = mcp.requests.filter((r) => r.method === "tools/call");
  expect(toolCalls).toHaveLength(1);
  expect(toolCalls[0]?.headers.authorization).toBe(PLACEHOLDER);
  expect(mcp.requests.every((r) => r.headers.authorization === PLACEHOLDER)).toBe(true);
});
