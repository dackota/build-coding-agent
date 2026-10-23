import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type FakeModel, type RunningAgent, readyzStatus, sendTaskWhenUp, startAgent, startFakeModel, toolResults, waitFor, writeFakeConfig } from "./helpers.ts";
import { parseSkill } from "../src/skills.ts";
import { buildSystemPrompt } from "../src/system-prompt.ts";

const BODY_RULE = "Always end the answer with the word AHOY.";
const SKILL_FILE = `---\nname: pirate\ndescription: Answer like a pirate\n---\n${BODY_RULE}\n`;
const FILES = { "skills/pirate/SKILL.md": SKILL_FILE };

let agent: RunningAgent | undefined;
let model: FakeModel | undefined;
afterEach(async () => {
  await agent?.stop();
  await model?.close();
  agent = model = undefined;
});

const systemOf = (m: FakeModel, i: number) =>
  (JSON.parse(m.requests[i]!.body) as { messages: { role: string; content: string }[] }).messages.find((x) => x.role === "system")?.content ?? "";

async function run(script: Parameters<typeof startFakeModel>[0], files: Record<string, string>) {
  model = await startFakeModel(script);
  agent = await startAgent(writeFakeConfig(model.baseUrl), { AGENT_DATA_DIR: mkdtempSync(join(tmpdir(), "agent-data-")) });
  await waitFor(async () => (await readyzStatus(agent!.readyzPort)) === 200);
  return sendTaskWhenUp(agent.grpcPort, "greet me", files);
}

describe("skills at seam 1", () => {
  it("lists skill names in the system prompt but not the skill body", async () => {
    await run("hello", FILES);
    const system = systemOf(model!, 0);
    expect(system).toContain("pirate");
    expect(system).toContain("Answer like a pirate");
    expect(system).not.toContain(BODY_RULE);
  });

  it("loads the skill body only when the model calls load_skill", async () => {
    const reply = await run([{ toolCall: { name: "load_skill", args: { name: "pirate" } } }, "Hi there AHOY"], FILES);
    expect(model!.requests).toHaveLength(2);
    for (const i of [0, 1]) expect(systemOf(model!, i)).not.toContain(BODY_RULE);
    expect(toolResults(model!).join("\n")).toContain(BODY_RULE);
    expect(toolResults(model!).join("\n")).not.toContain("description:");
    expect(reply.artifacts.reply).toBe("Hi there AHOY");
    expect(agent!.output()).toContain('"event":"skill-loaded"');
  });

  it("answers an unknown skill name with an error that lists the known names", async () => {
    await run([{ toolCall: { name: "load_skill", args: { name: "../../etc/passwd" } } }, "done"], FILES);
    const result = toolResults(model!).join("\n");
    expect(result).toContain("pirate");
    expect(result).not.toContain(BODY_RULE);
  });

  it("offers no load_skill section when the workspace has no skills", async () => {
    await run("hello", {});
    expect(systemOf(model!, 0)).not.toContain("load_skill");
  });
});

describe("skill parsing and prompt", () => {
  it("reads name, description and body from SKILL.md frontmatter", () => {
    expect(parseSkill("skills/x/SKILL.md", SKILL_FILE)).toEqual({ name: "pirate", description: "Answer like a pirate", path: "skills/x/SKILL.md", body: `${BODY_RULE}\n` });
  });

  it("falls back to the directory name when frontmatter is missing", () => {
    const s = parseSkill("skills/plain/SKILL.md", "Just text\n");
    expect(s.name).toBe("plain");
    expect(s.body).toBe("Just text\n");
  });

  it("puts only names and descriptions in the prompt", () => {
    const prompt = buildSystemPrompt({ instruction: "", toolNames: ["load_skill"], workspace: "/w", maxSteps: 5, skills: [{ name: "pirate", description: "Answer like a pirate" }] });
    expect(prompt).toContain("- pirate: Answer like a pirate");
    expect(prompt).toContain("load_skill");
  });
});
