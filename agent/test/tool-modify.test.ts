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
const ENV_FILE = { ".env.sample": "TOKEN=abc123\n" };
type Body = { model: string; messages: { role: string; content: string }[] };

/** Starts the agent on a fresh data dir. `extensionsDir` undefined means the shipped `extensions/` directory. */
async function boot(script: ScriptedReply[], extensionsDir?: string, opts: { subAgents?: unknown[]; env?: Record<string, string> } = {}): Promise<{ dataDir: string }> {
  model = await startFakeModel(script);
  const dataDir = mkdtempSync(join(tmpdir(), "agent-data-"));
  const env: Record<string, string> = { AGENT_DATA_DIR: dataDir, ...(extensionsDir ? { AGENT_EXTENSIONS_DIR: extensionsDir } : {}), ...opts.env };
  agent = await startAgent(writeFakeConfig(model.baseUrl, opts.subAgents ? { subAgents: opts.subAgents } : {}), env);
  await waitFor(async () => (await readyzStatus(agent!.readyzPort)) === 200);
  return { dataDir };
}

describe("tool_call modify at seam 1", () => {
  it("a tool_call modify of read_file README to README.md gives the model README.md's text", async () => {
    await boot([call("read_file", { path: "README" }), "done"], fixture("ext-rewrite"));

    await sendTaskWhenUp(agent!.grpcPort, "read README", { "README.md": "# Hello readme" });

    expect(toolResults(model!)).toEqual(["# Hello readme"]);
  });

  it("a tool_call modify to { path: 42 } is a schema error naming the extension, and write_file does not run", async () => {
    const { dataDir } = await boot([call("write_file", { path: "z.txt", content: "z" }), "done"], fixture("ext-rewrite"));

    const got = await sendTaskWhenUp(agent!.grpcPort, "write z.txt", {}, "ctx-bad-modify");

    expect(got.state).toBe(TaskState.TASK_STATE_COMPLETED);
    const result = toolResults(model!).join("\n");
    expect(result).toContain("extension rewrite gave write_file an invalid input");
    expect(result).toContain("path: Expected string, received number");
    expect(existsSync(join(workspace(dataDir, "ctx-bad-modify"), "z.txt"))).toBe(false);
    expect(got.artifacts.diff).toBeUndefined();
  });

  it("a refused modified input never puts an input value in the extension-failed log line", async () => {
    await boot([call("todo_write", { todos: [{ content: "x", status: "pending" }] }), "done"], fixture("ext-rewrite"));

    await sendTaskWhenUp(agent!.grpcPort, "plan it");

    expect(toolResults(model!).join("\n")).toContain("extension rewrite gave todo_write an invalid input: todos.0.status:");
    const failed = agent!
      .output()
      .split("\n")
      .filter((l) => l.includes('"event":"extension-failed"'));
    expect(failed).toHaveLength(1);
    expect(JSON.parse(failed[0]!).message).toBe("invalid input: todos.0.status: invalid_enum_value");
    expect(agent!.output()).not.toContain("SECRET-VALUE-123");
  });

  it("a modified write_file input changes the file and the diff", async () => {
    const { dataDir } = await boot([call("write_file", { path: "w.txt", content: "original" }), "done"], fixture("ext-rewrite"));

    const got = await sendTaskWhenUp(agent!.grpcPort, "write w.txt", {}, "ctx-modify-write");

    expect(toolResults(model!)).toEqual(["wrote 7 characters to w.txt"]);
    expect(readFileSync(join(workspace(dataDir, "ctx-modify-write"), "w.txt"), "utf8")).toBe("changed");
    expect(got.artifacts.diff).toContain("+changed");
    expect(got.artifacts.diff).not.toContain("original");
  });
});

describe("tool_result event at seam 1", () => {
  it("two tool_result handlers each append a tag, in load order", async () => {
    await boot([call("read_file", { path: "a.txt" }), "done"], fixture("ext-tags"));

    await sendTaskWhenUp(agent!.grpcPort, "read a.txt", { "a.txt": "alpha" });

    expect(toolResults(model!)).toEqual(["alpha[a][b]"]);
  });

  it("a tool_result output past the cap is still capped", async () => {
    const CAP = 500;
    await boot([call("read_file", { path: "a.txt" }), "done"], fixture("ext-big-result"), { env: { AGENT_MAX_TOOL_OUTPUT_CHARS: String(CAP) } });

    await sendTaskWhenUp(agent!.grpcPort, "read a.txt", { "a.txt": "alpha" });

    const [result] = toolResults(model!);
    expect(result!.length).toBeLessThanOrEqual(CAP);
    expect(result!.endsWith("[truncated]")).toBe(true);
  });
});

describe("shipped redact-env", () => {
  it("redact-env hides .env values in read_file, read_files and search", async () => {
    await boot([call("read_file", { path: ".env.sample" }), call("read_files", { paths: [".env.sample"] }), call("search", { pattern: "TOKEN" }), "done"]);

    await sendTaskWhenUp(agent!.grpcPort, "read .env.sample", ENV_FILE);

    const [readFile, readFiles, search] = toolResults(model!);
    expect(readFile).toBe("TOKEN=***\n");
    expect(readFiles).toContain("TOKEN=***");
    expect(search).toBe(".env.sample:1:TOKEN=***");
    expect(model!.requests.some((r) => r.body.includes("abc123"))).toBe(false);
  });

  it("redact-env holds for the explorer subagent's read_file and search", async () => {
    await boot([task("explorer", "read .env.sample"), call("read_file", { path: ".env.sample" }), call("search", { pattern: "TOKEN" }), "TOKEN=***", "Done."], undefined, { subAgents: SUB_AGENTS });

    const got = await sendTaskWhenUp(agent!.grpcPort, "have the explorer read .env.sample", ENV_FILE);

    expect(got.state).toBe(TaskState.TASK_STATE_COMPLETED);
    const bodies = model!.requests.map((r) => JSON.parse(r.body) as Body);
    const explorer = bodies.filter((b) => b.model === "cheap-model");
    const explorerTools = explorer.at(-1)!.messages.filter((m) => m.role === "tool").map((m) => m.content);
    expect(explorerTools).toHaveLength(2);
    expect(explorerTools.every((c) => c.includes("TOKEN=***"))).toBe(true);
    expect(model!.requests.some((r) => r.body.includes("abc123"))).toBe(false);
  });
});
