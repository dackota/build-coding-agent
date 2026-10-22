export type PromptFacts = {
  /** The system prompt from the kagent config. */
  instruction: string;
  toolNames: string[];
  /** The absolute path of the workspace root. */
  workspace: string;
  maxSteps: number;
  /** The workspace's AGENTS.md, when it has one. */
  agentsMd?: string;
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
  const rules = facts.agentsMd?.trim();
  if (rules) {
    sections.push(`Project rules (from ${AGENTS_MD_FILE} in the workspace; follow them):\n${rules}`);
  }
  return sections.join("\n\n");
}
