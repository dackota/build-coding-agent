export type PromptFacts = {
  /** The system prompt from the kagent config. */
  instruction: string;
  toolNames: string[];
  /** The absolute path of the workspace root. */
  workspace: string;
  maxSteps: number;
  /** The workspace's AGENTS.md, when it has one. */
  agentsMd?: string;
  skills?: { name: string; description: string }[];
};

export const AGENTS_MD_FILE = "AGENTS.md";

const VERIFICATION_CONTRACT = [
  "Verification contract: before you say a task is done, verify your changes with the project's own commands, in this order:",
  "1. typecheck  2. lint  3. test  4. build",
  "Find the commands in AGENTS.md, package.json, a Makefile, or the like, and run each one that exists with a tool that can run commands. Fix failures and run again.",
  "In your final answer, say which of the four you ran and whether it passed. If one does not exist, or you have no tool to run it, say so; never claim a check you did not run.",
].join("\n");

/** The system prompt: the config's instruction, runtime facts, the verification contract, then the project's AGENTS.md. */
export function buildSystemPrompt(facts: PromptFacts): string {
  const sections: string[] = [];
  if (facts.instruction.trim() !== "") sections.push(facts.instruction.trim());
  sections.push(
    [
      "Runtime facts:",
      `- Tools: ${facts.toolNames.join(", ")}.`,
      `- Workspace: ${facts.workspace} (use paths relative to it; nothing outside it is reachable).`,
      `- Limit: a turn ends after ${facts.maxSteps} steps (model calls), so work in few, purposeful steps.`,
    ].join("\n"),
  );
  sections.push(VERIFICATION_CONTRACT);
  if (facts.skills && facts.skills.length > 0) {
    sections.push(
      [
        "Skills (call load_skill with the name to read one in full before doing work it covers, then follow it):",
        ...facts.skills.map((s) => `- ${s.name}: ${s.description}`),
      ].join("\n"),
    );
  }
  const rules = facts.agentsMd?.trim();
  if (rules) {
    sections.push(`Project rules (from ${AGENTS_MD_FILE} in the workspace; follow them):\n${rules}`);
  }
  return sections.join("\n\n");
}
