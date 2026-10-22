// Subagents: the explorer and executor kagent AgentTemplates, bound with subAgent.templateRef
// and delivered in the config under agent.sub_agents. Each runs in-process as its own
// ToolLoopAgent with its own prompt and model, on the main agent's Sandbox, so what the
// executor writes is what the explorer reads. Nesting is one level: subagents get no task tool.
import { stepCountIs, type Tool, tool, ToolLoopAgent } from "ai";
import { z } from "zod";
import type { SubAgentDef } from "./config.ts";
import { capOutput, capTools, logStepUsage } from "./context.ts";
import { gatewayModel } from "./gateway.ts";
import { log } from "./log.ts";

/** The tools a subagent may use. The template carries no tool list, so the role is by name; anything but the executor is read-only. */
const READ_ONLY_TOOLS = ["read_file", "search"];
const FULL_TOOLS_AGENT = "executor";

export type TaskToolDeps = {
  /** The turn's built file tools, as the registry made them. */
  fileTools: Record<string, Tool>;
  taskId: string;
  opts: { maxSteps: number; maxToolOutputChars: number };
};

function toolsFor(def: SubAgentDef, deps: TaskToolDeps) {
  const all = deps.fileTools;
  const allowed = def.name === FULL_TOOLS_AGENT ? all : Object.fromEntries(Object.entries(all).filter(([name]) => READ_ONLY_TOOLS.includes(name)));
  return capTools(allowed, deps.opts.maxToolOutputChars);
}

/** The `task` tool: routes a job to the named subagent and returns its final text (capped). */
export function createTaskTool(defs: SubAgentDef[], deps: TaskToolDeps): Tool {
  const names = defs.map((d) => d.name);
  return tool({
    description: `Hand a job to a subagent and get its answer. It shares your workspace. Subagents: ${defs.map((d) => `${d.name} (${d.description || "no description"})`).join("; ")}. The explorer only reads; use the executor for changes. Give a complete prompt: the subagent does not see this conversation.`,
    inputSchema: z.object({
      agent: z.string().describe(`The subagent to use: ${names.join(", ")}`),
      prompt: z.string().min(1).describe("The full job for the subagent"),
    }),
    execute: async ({ agent: name, prompt }) => {
      const def = defs.find((d) => d.name === name);
      if (!def) throw new Error(`no subagent named ${JSON.stringify(name)}; available: ${names.join(", ")}`);
      log("subagent-call", { taskId: deps.taskId, agent: def.name, model: def.model });
      const model = gatewayModel(def.baseUrl, def.model);
      let step = 0;
      const sub = new ToolLoopAgent({
        model,
        instructions: def.instruction,
        tools: toolsFor(def, deps),
        stopWhen: stepCountIs(deps.opts.maxSteps),
        onStepFinish: (s) => {
          logStepUsage(deps.taskId, ++step, s.usage, def.name);
          for (const part of s.content) {
            if (part.type === "tool-error") log("subagent-tool-error", { taskId: deps.taskId, agent: def.name, tool: part.toolName, message: capOutput(String((part.error as Error)?.message ?? part.error), 300) });
          }
        },
      });
      const result = await sub.generate({ prompt });
      return capOutput(result.text || "(the subagent returned no text)", deps.opts.maxToolOutputChars);
    },
  });
}
