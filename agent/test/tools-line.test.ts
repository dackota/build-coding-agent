import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type FakeModel, type RunningAgent, readyzStatus, sendTaskWhenUp, startAgent, startFakeModel, waitFor, writeFakeConfig } from "./helpers.ts";

const BASE = "read_file, write_file, edit_file, search, bash, ask_user, todo_write";
const SKILL = { "skills/pirate/SKILL.md": "---\nname: pirate\ndescription: Answer like a pirate\n---\nAhoy.\n" };
const SUB_AGENTS = [{ name: "explorer", description: "read-only", instruction: "You explore.", model: { model: "cheap-model" }, stream: false }];

let agent: RunningAgent | undefined;
let model: FakeModel | undefined;
afterEach(async () => {
  await agent?.stop();
  await model?.close();
  agent = model = undefined;
});

/** The `- Tools:` line of the system prompt in the model's first request. */
async function toolsLine(files: Record<string, string>, subAgents?: typeof SUB_AGENTS): Promise<string> {
  model = await startFakeModel("hello");
  agent = await startAgent(writeFakeConfig(model.baseUrl, subAgents ? { subAgents } : {}), { AGENT_DATA_DIR: mkdtempSync(join(tmpdir(), "agent-data-")) });
  await waitFor(async () => (await readyzStatus(agent!.readyzPort)) === 200);
  await sendTaskWhenUp(agent.grpcPort, "hi", files);
  const body = JSON.parse(model.requests[0]!.body) as { messages: { role: string; content: string }[] };
  const system = body.messages.find((m) => m.role === "system")?.content ?? "";
  return system.split("\n").find((l) => l.startsWith("- Tools:")) ?? "";
}

describe("the system prompt's Tools line", () => {
  it("lists the built-ins in order with no skills, subagents or MCP bindings", async () => {
    expect(await toolsLine({})).toBe(`- Tools: ${BASE}, now.`);
  });
  it("adds load_skill last when the workspace has a skill", async () => {
    expect(await toolsLine(SKILL)).toBe(`- Tools: ${BASE}, load_skill, now.`);
  });
  it("adds task last when the config has subagents", async () => {
    expect(await toolsLine({}, SUB_AGENTS)).toBe(`- Tools: ${BASE}, task, now.`);
  });
});
