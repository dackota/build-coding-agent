// The turn's tools come from here: a registry of named tool factories. Built-ins register once,
// when the executor is made; each turn builds the tools from the turn context. The registry
// keeps every registered name, built this turn or not, so a later check can refuse a reserved
// name. `wrap` is applied to each tool as it is built (identity until the event wrapper).
import { AsyncLocalStorage } from "node:async_hooks";
import { asSchema, type Tool } from "ai";
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
  /**
   * For a custom tool, while it runs: runs a built-in tool that has an `execute` and was built this
   * turn, under the call id `<outer call id>:call-<n>`, and returns its output. Throws for anything else.
   */
  call: (name: string, input: unknown) => Promise<unknown>;
};

/** Builds one tool for the turn, or nothing when the tool does not apply this turn. */
export type ToolFactory = (ctx: TurnContext) => Tool | undefined;
export type ToolWrap = (name: string, tool: Tool) => Tool;

export type ToolRegistry = {
  /** `custom` marks an extension's tool: it gets the outer call id for `call`, and `call` refuses it. */
  register(name: string, factory: ToolFactory, opts?: { custom?: boolean }): void;
  /** Every registered name, in registration order. */
  names(): string[];
  /** The turn's tools: MCP tools first (minus any with a registered name), then the built ones in order. */
  build(ctx: Omit<TurnContext, "built" | "call">, mcpTools: Record<string, Tool>): Record<string, Tool>;
};

export function createToolRegistry(wrap: ToolWrap = (_name, tool) => tool): ToolRegistry {
  const factories = new Map<string, ToolFactory>();
  const customNames = new Set<string>();
  /** The running custom tool's call id and how many inner calls it has made. */
  const running = new AsyncLocalStorage<{ id: string; n: number }>();
  return {
    register(name, factory, opts) {
      if (factories.has(name)) throw new Error(`tool ${JSON.stringify(name)} is already registered`);
      factories.set(name, factory);
      if (opts?.custom) customNames.add(name);
    },
    names: () => [...factories.keys()],
    build(ctx, mcpTools) {
      const built = new Map<string, Tool>();
      const turnCtx: TurnContext = {
        ...ctx,
        built: (name) => built.get(name),
        call: async (name, input) => {
          const refuse = (why: string) => new Error(`call(${JSON.stringify(name)}) refused: ${why}`);
          const outer = running.getStore();
          if (!outer) throw refuse("call only works while a custom tool runs");
          const target = customNames.has(name) ? undefined : built.get(name);
          if (!target) throw refuse(factories.has(name) && !customNames.has(name) ? "that tool is not built this turn" : "only built-in tools can be called");
          if (typeof target.execute !== "function") throw refuse("that tool has no execute (it pauses the turn)");
          const checked = await asSchema(target.inputSchema).validate?.(input);
          if (checked && !checked.success) throw refuse(`invalid input: ${checked.error.message}`);
          const toolCallId = `${outer.id}:call-${++outer.n}`;
          return target.execute(checked?.success ? checked.value : input, { toolCallId, messages: [] });
        },
      };
      for (const [name, factory] of factories) {
        const t = factory(turnCtx);
        if (!t) continue;
        const wrapped = wrap(name, t);
        built.set(name, customNames.has(name) ? withCallScope(wrapped, running) : wrapped);
      }
      const external = Object.entries(mcpTools).filter(([name]) => !factories.has(name));
      return Object.fromEntries([...external, ...built]);
    },
  };
}

/** Runs a tool's execute inside a scope holding its call id, which `call` reads to name inner calls. */
function withCallScope(t: Tool, running: AsyncLocalStorage<{ id: string; n: number }>): Tool {
  const execute = t.execute;
  if (typeof execute !== "function") return t;
  return { ...t, execute: (input, options) => running.run({ id: options.toolCallId, n: 0 }, () => execute(input, options)) } as Tool;
}
