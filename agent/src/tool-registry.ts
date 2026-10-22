// The turn's tools come from here: a registry of named tool factories. Built-ins register once,
// when the executor is made; each turn builds the tools from the turn context. The registry
// keeps every registered name, built this turn or not, so a later check can refuse a reserved
// name. `wrap` is applied to each tool as it is built (identity until the event wrapper).
import type { Tool } from "ai";
import type { Sandbox } from "./sandbox.ts";
import type { Skill } from "./skills.ts";
import type { TodoHolder } from "./todo-tool.ts";
import type { ApprovalGate } from "./shell-tool.ts";
import type { ChangeTracker } from "./workspace-diff.ts";

export type TurnContext = {
  sandbox: Sandbox;
  changes: ChangeTracker;
  taskId: string;
  skills: Skill[];
  gate: ApprovalGate;
  todos: TodoHolder;
  /** The tool of that name built earlier this turn (wrapped), if any. */
  built: (name: string) => Tool | undefined;
};

/** Builds one tool for the turn, or nothing when the tool does not apply this turn. */
export type ToolFactory = (ctx: TurnContext) => Tool | undefined;
export type ToolWrap = (name: string, tool: Tool) => Tool;

export type ToolRegistry = {
  register(name: string, factory: ToolFactory): void;
  /** Every registered name, in registration order. */
  names(): string[];
  /** The turn's tools: MCP tools first (minus any with a registered name), then the built ones in order. */
  build(ctx: Omit<TurnContext, "built">, mcpTools: Record<string, Tool>): Record<string, Tool>;
};

export function createToolRegistry(wrap: ToolWrap = (_name, tool) => tool): ToolRegistry {
  const factories = new Map<string, ToolFactory>();
  return {
    register(name, factory) {
      if (factories.has(name)) throw new Error(`tool ${JSON.stringify(name)} is already registered`);
      factories.set(name, factory);
    },
    names: () => [...factories.keys()],
    build(ctx, mcpTools) {
      const built = new Map<string, Tool>();
      const turnCtx: TurnContext = { ...ctx, built: (name) => built.get(name) };
      for (const [name, factory] of factories) {
        const t = factory(turnCtx);
        if (t) built.set(name, wrap(name, t));
      }
      const external = Object.entries(mcpTools).filter(([name]) => !factories.has(name));
      return Object.fromEntries([...external, ...built]);
    },
  };
}
