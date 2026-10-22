import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TaskState } from "@a2a-js/sdk";
import { afterEach, expect, it } from "vitest";
import { buildSystemPrompt } from "../src/system-prompt.ts";
import { type FakeModel, type RunningAgent, readyzStatus, sendTaskWhenUp, startAgent, startFakeModel, toolResults, waitFor, writeFakeConfig } from "./helpers.ts";

let agent: RunningAgent | undefined;
let model: FakeModel | undefined;
afterEach(async () => {
  await agent?.stop();
  await model?.close();
  agent = model = undefined;
});

async function boot(configPath: string, dataDir: string): Promise<RunningAgent> {
  const running = await startAgent(configPath, { AGENT_DATA_DIR: dataDir, AGENT_SANDBOX: "memory" });
  await waitFor(async () => (await readyzStatus(running.readyzPort)) === 200);
  return running;
}

const systemOf = (m: FakeModel, i: number): string =>
  (JSON.parse(m.requests[i]!.body) as { messages: { role: string; content: string }[] }).messages.find((x) => x.role === "system")?.content ?? "";
const readTodos = (dataDir: string, contextId: string) =>
  (JSON.parse(readFileSync(join(dataDir, "sessions", contextId, "state.json"), "utf8")) as { todos: unknown[] }).todos;
const todoCall = (todos: { content: string; status: string }[]) => ({ toolCall: { name: "todo_write", args: { todos } } });

const PLAN = [
  { content: "find the config loader", status: "completed" },
  { content: "change the default port", status: "in_progress" },
  { content: "run the tests", status: "pending" },
];

it("keeps the todo list across a process restart and shows it to the model", async () => {
  model = await startFakeModel([todoCall(PLAN), "Planned.", "Continuing."]);
  const configPath = writeFakeConfig(model.baseUrl);
  const dataDir = mkdtempSync(join(tmpdir(), "agent-data-"));
  agent = await boot(configPath, dataDir);
  const first = await sendTaskWhenUp(agent.grpcPort, "plan the port change");
  expect(first.state).toBe(TaskState.TASK_STATE_COMPLETED);
  expect(readTodos(dataDir, first.contextId)).toEqual(PLAN);

  await agent.stop();
  agent = await boot(configPath, dataDir);
  const second = await sendTaskWhenUp(agent.grpcPort, "go on", {}, first.contextId);

  expect(second.state).toBe(TaskState.TASK_STATE_COMPLETED);
  expect(readTodos(dataDir, first.contextId)).toEqual(PLAN);
  // The cold-started process told the model the list, state by state.
  const system = systemOf(model, 2);
  expect(system).toContain("[completed] find the config loader");
  expect(system).toContain("[in_progress] change the default port");
  expect(system).toContain("[pending] run the tests");
});

it("replaces the whole list on each todo_write", async () => {
  const done = PLAN.map((t) => ({ ...t, status: "completed" }));
  model = await startFakeModel([todoCall(PLAN), todoCall(done), "All done."]);
  const dataDir = mkdtempSync(join(tmpdir(), "agent-data-"));
  agent = await boot(writeFakeConfig(model.baseUrl), dataDir);

  const reply = await sendTaskWhenUp(agent.grpcPort, "do it");

  expect(readTodos(dataDir, reply.contextId)).toEqual(done);
});

it("rejects an unknown status and keeps the list", async () => {
  model = await startFakeModel([todoCall(PLAN), todoCall([{ content: "x", status: "bogus" }]), "Ok."]);
  const dataDir = mkdtempSync(join(tmpdir(), "agent-data-"));
  agent = await boot(writeFakeConfig(model.baseUrl), dataDir);

  const reply = await sendTaskWhenUp(agent.grpcPort, "do it");

  expect(reply.state).toBe(TaskState.TASK_STATE_COMPLETED);
  expect(readTodos(dataDir, reply.contextId)).toEqual(PLAN);
  expect(toolResults(model).join("\n")).toMatch(/status/i);
});

it("shows the todo list with each state in the reply", async () => {
  model = await startFakeModel([todoCall(PLAN), "Planned."]);
  const dataDir = mkdtempSync(join(tmpdir(), "agent-data-"));
  agent = await boot(writeFakeConfig(model.baseUrl), dataDir);

  const reply = await sendTaskWhenUp(agent.grpcPort, "plan it");

  expect(reply.artifacts.todos).toContain("[completed] find the config loader");
  expect(reply.artifacts.todos).toContain("[in_progress] change the default port");
  expect(reply.artifacts.todos).toContain("[pending] run the tests");
});

it("has no todos artifact when the agent made no list", async () => {
  model = await startFakeModel(["Hi."]);
  const dataDir = mkdtempSync(join(tmpdir(), "agent-data-"));
  agent = await boot(writeFakeConfig(model.baseUrl), dataDir);

  const reply = await sendTaskWhenUp(agent.grpcPort, "hello");

  expect(reply.artifacts.todos).toBeUndefined();
});

it("tells the model to search first and tie claims to checks", async () => {
  model = await startFakeModel(["Hi."]);
  const dataDir = mkdtempSync(join(tmpdir(), "agent-data-"));
  agent = await boot(writeFakeConfig(model.baseUrl), dataDir);
  await sendTaskWhenUp(agent.grpcPort, "hello");

  const system = systemOf(model, 0);
  expect(system).toContain("todo_write");
  expect(system).toMatch(/search first/i);
  expect(system).toMatch(/read only (the files )?(you|what you)/i);
  expect(system).toMatch(/each claim.*check/i);
});

it("buildSystemPrompt lists the todos only when there are some", () => {
  const base = { instruction: "", toolNames: ["todo_write"], workspace: "/w", maxSteps: 3 };
  expect(buildSystemPrompt(base)).not.toContain("Current todo list");
  expect(buildSystemPrompt({ ...base, todos: [{ content: "a", status: "pending" }] })).toContain("Current todo list:\n1. [pending] a");
});
