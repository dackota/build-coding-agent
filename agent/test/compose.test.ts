import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { TaskState } from "@a2a-js/sdk";
import { afterEach, describe, expect, it } from "vitest";
import { type FakeModel, type RunningAgent, type ScriptedReply, readyzStatus, sendTaskWhenUp, startAgent, startFakeModel, toolResults, waitFor, writeFakeConfig } from "./helpers.ts";

let agent: RunningAgent | undefined;
let model: FakeModel | undefined;
afterEach(async () => {
  await agent?.stop();
  await model?.close();
  agent = model = undefined;
});

const composeDir = fileURLToPath(new URL("./fixtures/ext-compose", import.meta.url));
const call = (name: string, args: unknown): ScriptedReply => ({ toolCall: { name, args } });
const compose = (name: string, input: unknown) => call("compose", { name, input });

async function boot(script: ScriptedReply[], env: Record<string, string> = {}, subAgents?: unknown[]) {
  model = await startFakeModel(script);
  const dataDir = mkdtempSync(join(tmpdir(), "agent-data-"));
  agent = await startAgent(writeFakeConfig(model.baseUrl, subAgents ? { subAgents } : {}), { AGENT_DATA_DIR: dataDir, ...env });
  await waitFor(async () => (await readyzStatus(agent!.readyzPort)) === 200);
  return { dataDir, port: agent.grpcPort };
}

describe("read_files (shipped extension)", () => {
  it("returns both files' contents, each under its path", async () => {
    const { port } = await boot([call("read_files", { paths: ["a.txt", "b.txt"] }), "done"]);
    await sendTaskWhenUp(port, "read both", { "a.txt": "alpha", "b.txt": "bravo" });
    const result = toolResults(model!).join("\n");
    expect(result).toContain("a.txt");
    expect(result).toContain("alpha");
    expect(result).toContain("b.txt");
    expect(result).toContain("bravo");
  });

  it("gives a path's read_file error inside the result without failing the tool", async () => {
    const { port } = await boot([call("read_files", { paths: ["a.txt", "../x"] }), "done"]);
    const reply = await sendTaskWhenUp(port, "read both", { "a.txt": "alpha" });
    const result = toolResults(model!).join("\n");
    expect(result).toContain("alpha");
    expect(result).toContain("is outside the workspace");
    expect(reply.state).toBe(TaskState.TASK_STATE_COMPLETED);
  });
});

describe("call(name, input) from a custom tool", () => {
  it.each([
    ["a custom tool", "inner_custom", {}],
    ["ask_user", "ask_user", { question: "which?" }],
    ["load_skill with no skills", "load_skill", { name: "pirate" }],
    ["task with no subagents", "task", { agent: "explorer", prompt: "look" }],
    ["an unknown name", "no_such_tool", {}],
  ])("refuses %s", async (_label, name, input) => {
    const { port } = await boot([compose(name, input), "done"], { AGENT_EXTENSIONS_DIR: composeDir });
    await sendTaskWhenUp(port, "go");
    const result = toolResults(model!).join("\n");
    expect(result).toContain(`call("${name}")`);
    expect(result).not.toBe("inner");
  });

  it("runs todo_write like the model's own call", async () => {
    const { port } = await boot([compose("todo_write", { todos: [{ content: "step one", status: "pending" }] }), "done"], { AGENT_EXTENSIONS_DIR: composeDir });
    const reply = await sendTaskWhenUp(port, "go");
    expect(reply.state).toBe(TaskState.TASK_STATE_COMPLETED);
    expect(reply.artifacts.todos).toContain("1. [pending] step one");
  });

  it("cannot step around the shell gate: a risky bash is refused, no pause, file kept", async () => {
    const { port, dataDir } = await boot([compose("bash", { command: "rm a.txt" }), "done"], { AGENT_EXTENSIONS_DIR: composeDir });
    const reply = await sendTaskWhenUp(port, "go", { "a.txt": "keep" }, "ctx-compose");
    expect(toolResults(model!).join("\n")).toContain('refused: "rm a.txt" is risky (rm) and has no approval');
    expect(reply.state).toBe(TaskState.TASK_STATE_COMPLETED);
    expect(reply.artifacts.diff).toBeUndefined();
    expect(existsSync(join(dataDir, "workspaces", "ctx-compose", "a.txt"))).toBe(true);
  });
});
