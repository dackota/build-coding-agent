import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TaskState } from "@a2a-js/sdk";
import { afterEach, expect, it } from "vitest";
import { type FakeModel, type RunningAgent, readyzStatus, type ScriptedReply, startAgent, startFakeModel, toolResults, waitFor, writeFakeConfig } from "./helpers.ts";
import { sendTurn, type Turn } from "./hitl-client.ts";

let agent: RunningAgent | undefined;
let model: FakeModel | undefined;
afterEach(async () => {
  await agent?.stop();
  await model?.close();
  agent = model = undefined;
});

const bash = (command: string): ScriptedReply => ({ toolCall: { name: "bash", args: { command } } });

/** A repo with a test script, standing in for a public one: git reads it the same way over file://. */
function makeSourceRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "source-repo-"));
  writeFileSync(join(dir, "test.sh"), 'echo "1 passing: adds numbers"\n');
  const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { cwd: dir });
  git("init", "-q");
  git("add", ".");
  git("commit", "-q", "-m", "init");
  return dir;
}

async function boot(script: ScriptedReply[]) {
  model = await startFakeModel(script);
  const dataDir = mkdtempSync(join(tmpdir(), "agent-data-"));
  agent = await startAgent(writeFakeConfig(model.baseUrl), { AGENT_DATA_DIR: dataDir });
  await waitFor(async () => (await readyzStatus(agent!.readyzPort)) === 200);
  const contextId = `ctx-${crypto.randomUUID()}`;
  return { contextId, ws: join(dataDir, "workspaces", contextId) };
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

it("clones a repo with git clone after approval and runs its tests", async () => {
  const source = makeSourceRepo();
  const { contextId, ws } = await boot([
    bash(`git clone file://${source} project`),
    bash("sh project/test.sh"),
    "Cloned and tested: 1 passing.",
  ]);

  const askClone = await turn({ text: `clone ${source} and run its tests`, contextId });
  expect(askClone.state).toBe(TaskState.TASK_STATE_INPUT_REQUIRED);
  expect(askClone.approvalRequest?.tools[0]?.args).toEqual({ command: `git clone file://${source} project` });
  expect(existsSync(join(ws, "project"))).toBe(false);

  const askTest = await turn({
    text: "approve",
    taskId: askClone.taskId,
    contextId,
    approvals: [{ id: askClone.approvalRequest!.tools[0]!.id, approved: true }],
  });
  expect(existsSync(join(ws, "project", "test.sh"))).toBe(true);
  expect(askTest.state).toBe(TaskState.TASK_STATE_INPUT_REQUIRED);

  const done = await turn({
    text: "approve",
    taskId: askTest.taskId,
    contextId,
    approvals: [{ id: askTest.approvalRequest!.tools[0]!.id, approved: true }],
  });
  expect(done.state).toBe(TaskState.TASK_STATE_COMPLETED);
  expect(done.text).toContain("1 passing");
  expect(toolResults(model!).at(-1)).toContain("1 passing: adds numbers");
  expect(readFileSync(join(ws, "project", "test.sh"), "utf8")).toContain("passing");
});

it("git never prompts for credentials in the shell", async () => {
  const { contextId } = await boot([bash("echo $GIT_TERMINAL_PROMPT"), "Checked."]);

  const got = await turn({ text: "check", contextId });

  expect(got.state).toBe(TaskState.TASK_STATE_COMPLETED);
  expect(toolResults(model!)[0]).toMatch(/stdout:\n0\n/);
});
