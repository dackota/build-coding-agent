import { TaskState } from "@a2a-js/sdk";
import { afterEach, expect, it } from "vitest";
import { type FakeModel, type RunningAgent, type ScriptedReply, readyzStatus, sendTaskWhenUp, startAgent, startFakeModel, waitFor, writeFakeConfig } from "./helpers.ts";

let agent: RunningAgent | undefined;
let model: FakeModel | undefined;
afterEach(async () => {
  await agent?.stop();
  await model?.close();
  agent = model = undefined;
});

const SUB_AGENTS = [
  { name: "explorer", description: "read-only", instruction: "You explore.", model: { model: "cheap-model" }, stream: false },
  { name: "executor", description: "full tools", instruction: "You execute.", model: { model: "strong-model" }, stream: false },
];

async function boot(script: ScriptedReply[]): Promise<void> {
  model = await startFakeModel(script);
  agent = await startAgent(writeFakeConfig(model.baseUrl, { subAgents: SUB_AGENTS }));
  await waitFor(async () => (await readyzStatus(agent!.readyzPort)) === 200);
}
const call = (name: string, args: unknown): ScriptedReply => ({ toolCall: { name, args } });
const task = (subagent: string, prompt: string) => call("task", { agent: subagent, prompt });

type Body = { model: string; messages: { role: string; content: string }[] };
const bodies = (): Body[] => model!.requests.map((r) => JSON.parse(r.body) as Body);

it("an explorer attempt to write returns an error to the model and the file is not written", async () => {
  await boot([task("explorer", "write x.txt"), call("write_file", { path: "x.txt", content: "nope" }), "I could not write.", "Explorer could not write."]);

  const got = await sendTaskWhenUp(agent!.grpcPort, "try it");

  expect(got.state).toBe(TaskState.TASK_STATE_COMPLETED);
  expect(got.artifacts.diff).toBeUndefined();
  // The explorer's second request carries the error for its write_file call.
  const explorerReqs = bodies().filter((b) => b.model === "cheap-model");
  expect(explorerReqs).toHaveLength(2);
  const toolMsg = explorerReqs[1]!.messages.find((m) => m.role === "tool");
  expect(toolMsg?.content).toMatch(/write_file/);
  expect(JSON.stringify(explorerReqs[0])).not.toContain('"name":"write_file"');
  expect(agent!.output()).toMatch(/"event":"subagent-tool-error".*"agent":"explorer".*"tool":"write_file"/);
});

it("the executor subagent writes a file", async () => {
  await boot([task("executor", "write hello.txt"), call("write_file", { path: "hello.txt", content: "hi there\n" }), "Wrote it.", "Done."]);

  const got = await sendTaskWhenUp(agent!.grpcPort, "have the executor write hello.txt");

  expect(got.state).toBe(TaskState.TASK_STATE_COMPLETED);
  expect(got.artifacts.diff).toContain("hi there");
  expect(got.artifacts.reply).toBe("Done.");
});

it("a file the executor writes is visible to the explorer", async () => {
  await boot([
    task("executor", "write hello.txt"),
    call("write_file", { path: "hello.txt", content: "SHARED-CONTENT\n" }),
    "Wrote it.",
    task("explorer", "read hello.txt"),
    call("read_file", { path: "hello.txt" }),
    "It says SHARED-CONTENT.",
    "The file says SHARED-CONTENT.",
  ]);

  const got = await sendTaskWhenUp(agent!.grpcPort, "executor writes, explorer reads");

  expect(got.artifacts.reply).toBe("The file says SHARED-CONTENT.");
  const explorerReqs = bodies().filter((b) => b.model === "cheap-model");
  expect(explorerReqs.at(-1)!.messages.find((m) => m.role === "tool")?.content).toContain("SHARED-CONTENT");
});

it("each subagent calls the model named in its own template", async () => {
  await boot([task("explorer", "look"), "Nothing.", task("executor", "do"), "Did.", "All done."]);

  await sendTaskWhenUp(agent!.grpcPort, "go");

  expect(bodies().map((b) => b.model)).toEqual(["scripted-model", "cheap-model", "scripted-model", "strong-model", "scripted-model"]);
  const lines = agent!.output().split("\n").filter((l) => l.includes('"event":"subagent-call"')).map((l) => JSON.parse(l));
  expect(lines.map((l) => [l.agent, l.model])).toEqual([
    ["explorer", "cheap-model"],
    ["executor", "strong-model"],
  ]);
  const usage = agent!.output().split("\n").filter((l) => l.includes('"event":"step-usage"') && l.includes('"agent"')).map((l) => JSON.parse(l));
  expect(usage.map((u) => u.agent)).toEqual(["explorer", "executor"]);
});

it("an unknown subagent name is an error to the model, not a crash", async () => {
  await boot([task("nobody", "x"), "Fine."]);

  const got = await sendTaskWhenUp(agent!.grpcPort, "go");

  expect(got.state).toBe(TaskState.TASK_STATE_COMPLETED);
  expect(bodies().at(-1)!.messages.find((m) => m.role === "tool")?.content).toMatch(/nobody/);
});

it("offers no task tool when the config has no subagents", async () => {
  model = await startFakeModel("ok");
  agent = await startAgent(writeFakeConfig(model.baseUrl));
  await waitFor(async () => (await readyzStatus(agent!.readyzPort)) === 200);

  await sendTaskWhenUp(agent!.grpcPort, "hi");

  expect(model.requests[0]!.body).not.toContain('"name":"task"');
});
