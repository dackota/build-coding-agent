import { existsSync, mkdtempSync, readFileSync } from "node:fs";
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

const fixture = (name: string) => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));
const call = (name: string, args: unknown): ScriptedReply => ({ toolCall: { name, args } });
const task = (subagent: string, prompt: string) => call("task", { agent: subagent, prompt });
const workspace = (dataDir: string, contextId: string) => join(dataDir, "workspaces", contextId);
const SUB_AGENTS = [
  { name: "explorer", description: "read-only", instruction: "You explore.", model: { model: "cheap-model" }, stream: false },
  { name: "executor", description: "full tools", instruction: "You execute.", model: { model: "strong-model" }, stream: false },
];

/** Starts the agent on a fresh data dir. `extensionsDir` undefined means the shipped `extensions/` directory. */
async function boot(script: ScriptedReply[], extensionsDir?: string, subAgents?: unknown[]): Promise<{ dataDir: string }> {
  model = await startFakeModel(script);
  const dataDir = mkdtempSync(join(tmpdir(), "agent-data-"));
  const env: Record<string, string> = { AGENT_DATA_DIR: dataDir, ...(extensionsDir ? { AGENT_EXTENSIONS_DIR: extensionsDir } : {}) };
  agent = await startAgent(writeFakeConfig(model.baseUrl, subAgents ? { subAgents } : {}), env);
  await waitFor(async () => (await readyzStatus(agent!.readyzPort)) === 200);
  return { dataDir };
}

/** The parsed log lines of one event. */
const logLines = (event: string): Record<string, string>[] =>
  agent!
    .output()
    .split("\n")
    .filter((l) => l.includes(`"event":"${event}"`))
    .map((l) => JSON.parse(l) as Record<string, string>);

describe("tool_call event at seam 1", () => {
  it("a block on write_file x.txt gives the model the reason, writes nothing and sends no diff", async () => {
    const { dataDir } = await boot([call("write_file", { path: "x.txt", content: "nope" }), "done"], fixture("ext-block-x"));

    const got = await sendTaskWhenUp(agent!.grpcPort, "write x.txt", {}, "ctx-block-x");

    expect(got.state).toBe(TaskState.TASK_STATE_COMPLETED);
    expect(toolResults(model!)).toEqual(["blocked by block-x: x.txt is off limits"]);
    expect(existsSync(join(workspace(dataDir, "ctx-block-x"), "x.txt"))).toBe(false);
    expect(got.artifacts.diff).toBeUndefined();
    const blocked = logLines("extension-blocked");
    expect(blocked.map((l) => [l.tool, l.extension])).toEqual([["write_file", "block-x"]]);
    expect(JSON.stringify(blocked)).not.toContain("nope");
  });

  it("a watching handler sees every tool call of the turn in order, and each call still runs", async () => {
    const { dataDir } = await boot(
      [call("read_file", { path: "a.txt" }), call("write_file", { path: "b.txt", content: "bravo" }), call("search", { pattern: "alpha" }), "done"],
      fixture("ext-watch"),
    );

    const got = await sendTaskWhenUp(agent!.grpcPort, "go", { "a.txt": "alpha" }, "ctx-watch");

    expect(got.state).toBe(TaskState.TASK_STATE_COMPLETED);
    expect(logLines("fixture-seen").map((l) => l.tool)).toEqual(["read_file", "write_file", "search"]);
    const results = toolResults(model!);
    expect(results[0]).toBe("alpha");
    expect(results[2]).toContain("a.txt:1:alpha");
    expect(readFileSync(join(workspace(dataDir, "ctx-watch"), "b.txt"), "utf8")).toBe("bravo");
    expect(got.artifacts.diff).toContain("+bravo");
  });

  it("a block on read_file also stops read_files' inner read of that path", async () => {
    await boot([call("read_files", { paths: ["a.txt", "secret.txt"] }), "done"], fixture("ext-block-read"));

    await sendTaskWhenUp(agent!.grpcPort, "read both", { "a.txt": "alpha", "secret.txt": "TOP-SECRET" });

    const result = toolResults(model!).join("\n");
    expect(result).toContain("alpha");
    expect(result).toContain("blocked by block-read: secret.txt is private");
    expect(result).not.toContain("TOP-SECRET");
    expect(logLines("extension-blocked").map((l) => [l.tool, l.extension])).toEqual([["read_file", "block-read"]]);
  });

  it("a throwing handler fails the call closed: the tool does not run and the log has extension-failed", async () => {
    const { dataDir } = await boot([call("write_file", { path: "y.txt", content: "y" }), "done"], fixture("ext-throw-call"));

    const got = await sendTaskWhenUp(agent!.grpcPort, "write y.txt", {}, "ctx-throw");

    expect(got.state).toBe(TaskState.TASK_STATE_COMPLETED);
    expect(toolResults(model!).join("\n")).toContain("extension boom-call failed on tool_call");
    expect(existsSync(join(workspace(dataDir, "ctx-throw"), "y.txt"))).toBe(false);
    expect(got.artifacts.diff).toBeUndefined();
    const failed = logLines("extension-failed");
    expect(failed.map((l) => [l.lifecycleEvent, l.extension, l.message])).toEqual([["tool_call", "boom-call", "policy exploded"]]);
  });
});

describe("shipped tool_call extensions", () => {
  const ENV_SCRIPT = [
    call("write_file", { path: ".env", content: "FOO=1" }),
    call("write_file", { path: "app/config/.env.local", content: "FOO=1" }),
    call("edit_file", { path: ".env.example", old_string: "A=1", new_string: "A=2" }),
    call("write_file", { path: "notes.env.txt", content: "fine" }),
    "done",
  ];

  it("protect-env blocks write_file and edit_file on .env and .env.* at any depth", async () => {
    const { dataDir } = await boot(ENV_SCRIPT);

    const got = await sendTaskWhenUp(agent!.grpcPort, "go", { ".env.example": "A=1\n" }, "ctx-env");

    const results = toolResults(model!);
    expect(results.slice(0, 3).every((r) => r.startsWith("blocked by protect-env: "))).toBe(true);
    expect(results[3]).toBe("wrote 4 characters to notes.env.txt");
    const ws = workspace(dataDir, "ctx-env");
    expect(existsSync(join(ws, ".env"))).toBe(false);
    expect(existsSync(join(ws, "app", "config", ".env.local"))).toBe(false);
    expect(readFileSync(join(ws, ".env.example"), "utf8")).toBe("A=1\n");
    expect(got.artifacts.diff).toContain("+++ b/notes.env.txt");
    expect(got.artifacts.diff).not.toContain("FOO");
    expect(logLines("extension-blocked").map((l) => [l.tool, l.extension])).toEqual([
      ["write_file", "protect-env"],
      ["write_file", "protect-env"],
      ["edit_file", "protect-env"],
    ]);
  });

  it("audit logs a tool-call line with the tool name for every call, blocked or not, and never the input", async () => {
    await boot(ENV_SCRIPT);

    await sendTaskWhenUp(agent!.grpcPort, "go", { ".env.example": "A=1\n" }, "ctx-audit");

    const audit = logLines("tool-call");
    expect(audit.map((l) => l.tool)).toEqual(["write_file", "write_file", "edit_file", "write_file"]);
    expect(JSON.stringify(audit)).not.toContain("FOO");
  });

  it("protect-env blocks the executor subagent's write_file .env", async () => {
    const { dataDir } = await boot([task("executor", "write .env"), call("write_file", { path: ".env", content: "FOO=1" }), "It was blocked.", "Done."], undefined, SUB_AGENTS);

    const got = await sendTaskWhenUp(agent!.grpcPort, "have the executor write .env", {}, "ctx-sub-env");

    expect(got.state).toBe(TaskState.TASK_STATE_COMPLETED);
    const executorReqs = model!.requests.map((r) => JSON.parse(r.body) as { model: string; messages: { role: string; content: string }[] }).filter((b) => b.model === "strong-model");
    expect(executorReqs).toHaveLength(2);
    expect(executorReqs[1]!.messages.find((m) => m.role === "tool")?.content).toMatch(/^blocked by protect-env: /);
    expect(existsSync(join(workspace(dataDir, "ctx-sub-env"), ".env"))).toBe(false);
    expect(got.artifacts.diff).toBeUndefined();
    expect(agent!.output()).toMatch(/"event":"extension-blocked".*"tool":"write_file".*"extension":"protect-env"/);
  });
});
