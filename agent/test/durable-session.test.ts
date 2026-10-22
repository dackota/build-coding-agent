import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
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

async function boot(configPath: string, dataDir: string): Promise<RunningAgent> {
  const running = await startAgent(configPath, { AGENT_DATA_DIR: dataDir, AGENT_SANDBOX: "memory" });
  await waitFor(async () => (await readyzStatus(running.readyzPort)) === 200);
  return running;
}

type ChatMessage = { role: string; content: unknown };
const sentMessages = (m: FakeModel, i: number): ChatMessage[] => (JSON.parse(m.requests[i]!.body) as { messages: ChatMessage[] }).messages;
const readState = (dataDir: string, contextId: string) =>
  JSON.parse(readFileSync(join(dataDir, "sessions", contextId, "state.json"), "utf8")) as { messages: ChatMessage[]; todos: unknown[]; pending?: unknown };

it("continues the conversation after the process restarts between turns", async () => {
  model = await startFakeModel(["Noted: 42.", "The number is 42."]);
  const configPath = writeFakeConfig(model.baseUrl);
  const dataDir = mkdtempSync(join(tmpdir(), "agent-data-"));
  agent = await boot(configPath, dataDir);
  const first = await sendTaskWhenUp(agent.grpcPort, "remember the number 42");
  expect(first.state).toBe(TaskState.TASK_STATE_COMPLETED);

  // A cold wake: process memory is gone, the data dir is kept.
  await agent.stop();
  agent = await boot(configPath, dataDir);
  const second = await sendTaskWhenUp(agent.grpcPort, "what number?", {}, first.contextId);

  expect(second.state).toBe(TaskState.TASK_STATE_COMPLETED);
  expect(second.contextId).toBe(first.contextId);
  expect(second.artifacts.reply).toBe("The number is 42.");
  // The new process sent the model the whole conversation, from disk.
  const sent = sentMessages(model, 1).filter((m) => m.role !== "system");
  expect(sent.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
  expect(JSON.stringify(sent[0])).toContain("remember the number 42");
  expect(JSON.stringify(sent[1])).toContain("Noted: 42.");
  expect(JSON.stringify(sent[2])).toContain("what number?");
  // The session on disk holds both turns, todos, no pending pause, and no temp files.
  const saved = readState(dataDir, first.contextId);
  expect(saved.messages.map((m) => m.role)).toEqual(["user", "assistant", "user", "assistant"]);
  expect(JSON.stringify(saved.messages.at(-1))).toContain("The number is 42.");
  expect(saved.todos).toEqual([]);
  expect(saved.pending).toBeUndefined();
  expect(readdirSync(join(dataDir, "sessions", first.contextId))).toEqual(["state.json"]);
  // The log says the same, for a live check that has no shell in the actor.
  expect(agent.output()).toMatch(/"event":"session-saved".*"messages":4,"todos":0,"pending":"","files":"state.json"/);
});

it("saves the session after every step, so a turn that fails mid-way keeps its finished steps", async () => {
  model = await startFakeModel([{ toolCall: { name: "write_file", args: { path: "notes.txt", content: "forty-two" } } }, { error: 400 }]);
  const dataDir = mkdtempSync(join(tmpdir(), "agent-data-"));
  agent = await boot(writeFakeConfig(model.baseUrl), dataDir);

  const failed = await sendTaskWhenUp(agent.grpcPort, "write the number down");

  expect(failed.state).toBe(TaskState.TASK_STATE_FAILED);
  const saved = readState(dataDir, failed.contextId);
  // The user message, the model's write_file call, and its result: the step that finished.
  expect(saved.messages.map((m) => m.role)).toEqual(["user", "assistant", "tool"]);
  expect(JSON.stringify(saved.messages[1])).toContain("write_file");
  expect(readdirSync(join(dataDir, "sessions", failed.contextId))).toEqual(["state.json"]);
});
