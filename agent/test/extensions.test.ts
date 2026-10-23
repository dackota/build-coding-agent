import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { type FakeModel, type RunningAgent, readyzStatus, sendTaskWhenUp, startAgent, startFakeModel, toolResults, waitFor, writeFakeConfig } from "./helpers.ts";

let agent: RunningAgent | undefined;
let model: FakeModel | undefined;
afterEach(async () => {
  await agent?.stop();
  await model?.close();
  agent = model = undefined;
});

const fixture = (name: string) => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));
const echoCall = { toolCall: { name: "echo", args: { text: "pineapple" } } };

async function boot(extensionsDir: string, env: Record<string, string> = {}, script: Parameters<typeof startFakeModel>[0] = [echoCall, "done"], subAgents?: unknown[]) {
  model = await startFakeModel(script);
  agent = await startAgent(writeFakeConfig(model.baseUrl, subAgents ? { subAgents } : {}), { AGENT_EXTENSIONS_DIR: extensionsDir, ...env });
  return agent;
}

/** The startup-failed line the agent printed, once it did. */
async function startupFailed(extensionsDir: string, env: Record<string, string> = {}, subAgents?: unknown[]): Promise<string> {
  const a = await boot(extensionsDir, env, undefined, subAgents);
  await waitFor(async () => a.output().includes('"event":"startup-failed"'));
  return a.output().split("\n").find((l) => l.includes('"event":"startup-failed"')) ?? "";
}

describe("extension tools at seam 1", () => {
  it("a registered tool is callable and returns the extension's output", async () => {
    const a = await boot(fixture("ext-echo"));
    await waitFor(async () => (await readyzStatus(a.readyzPort)) === 200);
    await sendTaskWhenUp(a.grpcPort, "echo it");
    expect(toolResults(model!)).toContain("pineapple");
  });

  it("lists echo after the built-ins in the system prompt", async () => {
    const a = await boot(fixture("ext-echo"), {}, "hi");
    await waitFor(async () => (await readyzStatus(a.readyzPort)) === 200);
    await sendTaskWhenUp(a.grpcPort, "hi");
    const body = JSON.parse(model!.requests[0]!.body) as { messages: { role: string; content: string }[] };
    const line = body.messages.find((m) => m.role === "system")?.content.split("\n").find((l) => l.startsWith("- Tools:"));
    expect(line).toBe("- Tools: read_file, write_file, edit_file, search, bash, ask_user, todo_write, echo.");
  });

  it("logs one extension-loaded line with names only", async () => {
    const a = await boot(fixture("ext-echo"));
    await waitFor(async () => (await readyzStatus(a.readyzPort)) === 200);
    const lines = a.output().split("\n").filter((l) => l.includes('"event":"extension-loaded"'));
    expect(lines).toHaveLength(1);
    const entry = JSON.parse(lines[0]!) as Record<string, string>;
    expect(entry.extension).toBe("echo.ts");
    expect(entry.tools).toBe("echo");
    expect(Object.keys(entry).sort()).toEqual(["event", "extension", "t", "tools"]);
  });
});

describe("a bad extension stops startup", () => {
  it.each([
    ["ext-dup", "b-echo.ts", "echo"],
    ["ext-read-file", "read_file.ts", "read_file"],
    ["ext-todo-write", "todo_write.ts", "todo_write"],
    ["ext-load-skill", "load_skill.ts", "load_skill"],
    ["ext-task", "task.ts", "task"],
    ["ext-no-default", "nodefault.ts", "default"],
    ["ext-throws", "boom.ts", "setup exploded"],
  ])("%s: names %s and %s", async (dir, file, what) => {
    const line = await startupFailed(fixture(dir));
    expect(line).toContain(file);
    expect(line).toContain(what);
  });

  it("names the directory when AGENT_EXTENSIONS_DIR is missing", async () => {
    const missing = join(tmpdir(), "no-such-extensions-dir");
    expect(await startupFailed(missing)).toContain(missing);
  });

  it("names the directory when it is under AGENT_DATA_DIR", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "agent-data-"));
    const inside = join(dataDir, "workspaces", "ext");
    mkdirSync(inside, { recursive: true });
    expect(await startupFailed(inside, { AGENT_DATA_DIR: dataDir })).toContain(inside);
  });
});
