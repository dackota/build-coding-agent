// Skills come from two places: read-only folders that kagent mounts from the template's
// `skills` (named by agent.agent_plugins in the config), and SKILL.md files under skills/<name>/
// in the workspace. On a name clash the template skill wins. The prompt lists names and
// descriptions; the body reaches the model only through the load_skill tool.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { tool } from "ai";
import { z } from "zod";
import type { SkillSource } from "./config.ts";
import { log } from "./log.ts";
import { type Sandbox, shellQuote } from "./sandbox.ts";

export const SKILLS_DIR = "skills";
const SKILL_FILE = "SKILL.md";
const MAX_SKILLS = 50;

export type Skill = { name: string; description: string; path: string; body: string };

/** Reads `name` and `description` from the leading `---` frontmatter; the rest is the body. */
export function parseSkill(path: string, text: string): Skill {
  const fallbackName = path.split("/").slice(-2, -1)[0] ?? path;
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!match) return { name: fallbackName, description: "", path, body: text };
  const field = (key: string) => new RegExp(`^${key}:\\s*(.*)$`, "m").exec(match[1]!)?.[1]?.trim().replace(/^["']|["']$/g, "") ?? "";
  return { name: field("name") || fallbackName, description: field("description"), path, body: match[2]! };
}

/** One template skill, read from its mounted folder. A folder without a readable SKILL.md is logged and skipped. */
function readTemplateSkill({ name, dir }: SkillSource): Skill | undefined {
  const path = join(dir, SKILL_FILE);
  try {
    return { ...parseSkill(path, readFileSync(path, "utf8")), name };
  } catch (err) {
    log("skill-unreadable", { skill: name, path, error: (err as Error).message });
    return undefined;
  }
}

/** The template's and the workspace's skills, sorted by name. A template skill wins a name clash. */
export async function discoverSkills(sandbox: Sandbox, templateSkills: readonly SkillSource[] = []): Promise<Skill[]> {
  const fromTemplate = templateSkills.map(readTemplateSkill).filter((s): s is Skill => s !== undefined);
  const found = await sandbox.exec(`find ${shellQuote(SKILLS_DIR)} -name ${shellQuote(SKILL_FILE)} -type f`);
  const paths = found.exitCode !== 0 ? [] : found.stdout.split("\n").filter(Boolean).sort().slice(0, MAX_SKILLS);
  const fromWorkspace = await Promise.all(paths.map(async (p) => parseSkill(p, await sandbox.readFile(p))));
  const templateByName = new Map(fromTemplate.map((s) => [s.name, s]));
  const kept = fromWorkspace.filter((s) => {
    const winner = templateByName.get(s.name);
    if (winner) log("skill-clash", { skill: s.name, kept: winner.path, dropped: s.path });
    return !winner;
  });
  return [...fromTemplate, ...kept].sort((a, b) => a.name.localeCompare(b.name));
}

/** load_skill: the full body of a listed skill. The model gives a name, never a path. */
export function createSkillTool(skills: Skill[], taskId: string) {
  return tool({
    description: "Load the full instructions of one listed skill. Call it before doing work a skill covers, then follow it.",
    inputSchema: z.object({ name: z.string().describe("A skill name from the Skills list") }),
    execute: async ({ name }) => {
      const skill = skills.find((s) => s.name === name);
      if (!skill) throw new Error(`no skill named ${JSON.stringify(name)}; the skills are: ${skills.map((s) => s.name).join(", ")}`);
      log("skill-loaded", { taskId, skill: skill.name, chars: skill.body.length });
      return skill.body;
    },
  });
}
