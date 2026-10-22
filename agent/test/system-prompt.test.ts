import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type FakeModel, type RunningAgent, readyzStatus, sendTaskWhenUp, startAgent, startFakeModel, waitFor, writeFakeConfig } from "./helpers.ts";
import { createLocalSandbox } from "../src/local-sandbox.ts";
import { OutsideWorkspaceError, readIfExists } from "../src/sandbox.ts";
import { buildSystemPrompt } from "../src/system-prompt.ts";

let agent: RunningAgent | undefined;
let model: FakeModel | undefined;
afterEach(async () => {
  await agent?.stop();
  await model?.close();
  agent = model = undefined;
});

/** The system message the first model request carried. */
function systemMessage(m: FakeModel): string {
  const body = JSON.parse(m.requests[0]!.body) as { messages: { role: string; content: string }[] };
  return body.messages.find((x) => x.role === "system")?.content ?? "";
}

async function run(files: Record<string, string>, env: Record<string, string> = {}) {
  model = await startFakeModel();
  const dataDir = mkdtempSync(join(tmpdir(), "agent-data-"));
  agent = await startAgent(writeFakeConfig(model.baseUrl), { AGENT_DATA_DIR: dataDir, ...env });
  await waitFor(async () => (await readyzStatus(agent!.readyzPort)) === 200);
  await sendTaskWhenUp(agent.grpcPort, "do it", files);
  return { system: systemMessage(model), dataDir };
}

describe("system prompt at seam 1", () => {
  it("sends the config instruction to the model", async () => {
    const { system } = await run({});
    expect(system).toContain("You are a test agent. Reply briefly.");
  });

  it("adds the AGENTS.md rules from the workspace to what the model receives", async () => {
    const { system } = await run({ "AGENTS.md": "Start every answer with the word PINEAPPLE.\n" });
    expect(system).toContain("Start every answer with the word PINEAPPLE.");
    expect(system).toContain("AGENTS.md");
  });

  it("has no AGENTS.md section when the workspace has none", async () => {
    const { system } = await run({});
    expect(system).not.toContain("Project rules");
  });

  it("names the tools, the workspace path, the step limit, and the verification contract", async () => {
    const { system, dataDir } = await run({}, { AGENT_MAX_STEPS: "7" });
    for (const t of ["read_file", "write_file", "edit_file", "search", "ask_user"]) expect(system).toContain(t);
    expect(system).toContain(join(dataDir, "workspaces"));
    expect(system).toMatch(/7 steps/);
    for (const w of ["typecheck", "lint", "test", "build"]) expect(system.toLowerCase()).toContain(w);
  });
});

describe("buildSystemPrompt", () => {
  const base = { instruction: "Be brief.", toolNames: ["a_tool"], workspace: "/w", maxSteps: 3 };

  it("puts the config instruction first", () => {
    expect(buildSystemPrompt(base).startsWith("Be brief.")).toBe(true);
  });

  it("leaves out an empty instruction", () => {
    expect(buildSystemPrompt({ ...base, instruction: "" }).startsWith("Runtime facts:")).toBe(true);
  });

  it("includes AGENTS.md text only when given", () => {
    expect(buildSystemPrompt({ ...base, agentsMd: "RULE-X" })).toContain("RULE-X");
    expect(buildSystemPrompt(base)).not.toContain("RULE-X");
  });

  it("states the ambiguity rule when ask_user is a tool", () => {
    const prompt = buildSystemPrompt({ ...base, toolNames: ["a_tool", "ask_user"] });
    expect(prompt).toMatch(/do not guess/i);
    expect(prompt).toMatch(/ask_user/);
    expect(prompt).toMatch(/choices/i);
    expect(buildSystemPrompt(base)).not.toMatch(/do not guess/i);
  });

  it("keeps AGENTS.md whole, however large", () => {
    const big = `${"x".repeat(200_000)}END`;
    expect(buildSystemPrompt({ ...base, agentsMd: big })).toContain(big);
  });
});

describe("readIfExists", () => {
  it("is undefined for a missing file and the text for a present one", async () => {
    const root = mkdtempSync(join(tmpdir(), "ws-"));
    const sandbox = await createLocalSandbox(root);
    expect(await readIfExists(sandbox, "AGENTS.md")).toBeUndefined();
    writeFileSync(join(root, "AGENTS.md"), "rules");
    expect(await readIfExists(sandbox, "AGENTS.md")).toBe("rules");
  });

  it("rejects when the file is a symlink out of the workspace", async () => {
    const root = mkdtempSync(join(tmpdir(), "ws-"));
    const outside = mkdtempSync(join(tmpdir(), "out-"));
    writeFileSync(join(outside, "secret"), "s");
    mkdirSync(root, { recursive: true });
    symlinkSync(join(outside, "secret"), join(root, "AGENTS.md"));
    const sandbox = await createLocalSandbox(root);
    await expect(readIfExists(sandbox, "AGENTS.md")).rejects.toBeInstanceOf(OutsideWorkspaceError);
  });
});
