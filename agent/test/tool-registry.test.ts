import { type Tool, tool } from "ai";
import { z } from "zod";
import { expect, it } from "vitest";
import type { Sandbox } from "../src/sandbox.ts";
import type { ApprovalGate } from "../src/shell-tool.ts";
import type { ChangeTracker } from "../src/workspace-diff.ts";
import { createToolRegistry, type TurnContext } from "../src/tool-registry.ts";

const mk = (description: string): Tool => tool({ description, inputSchema: z.object({}), execute: async () => description });
/** The registry never reads the sandbox, tracker, gate or todos, so stubs stand in. */
const ctx = (): Omit<TurnContext, "built" | "call"> => ({ sandbox: {} as Sandbox, changes: {} as ChangeTracker, taskId: "t", skills: [], gate: {} as ApprovalGate, todos: { list: [] } });

it("builds registered tools in registration order, after the MCP tools", () => {
  const reg = createToolRegistry();
  reg.register("a", () => mk("a"));
  reg.register("b", () => mk("b"));
  const tools = reg.build(ctx(), { m1: mk("m1"), m2: mk("m2") });
  expect(Object.keys(tools)).toEqual(["m1", "m2", "a", "b"]);
});

it("drops an MCP tool whose name is registered, even when the factory builds nothing", () => {
  const reg = createToolRegistry();
  reg.register("a", () => mk("built-in a"));
  reg.register("skip", () => undefined);
  const tools = reg.build(ctx(), { a: mk("mcp a"), skip: mk("mcp skip"), other: mk("other") });
  expect(Object.keys(tools)).toEqual(["other", "a"]);
  expect(tools.a?.description).toBe("built-in a");
});

it("keeps every registered name, built or not", () => {
  const reg = createToolRegistry();
  reg.register("a", () => mk("a"));
  reg.register("skip", () => undefined);
  reg.build(ctx(), {});
  expect(reg.names()).toEqual(["a", "skip"]);
});

it("lets a factory read a tool built earlier this turn through built(name)", () => {
  const reg = createToolRegistry();
  reg.register("a", () => mk("a"));
  reg.register("b", (c) => (c.built("a") ? mk("b sees a") : mk("b misses a")));
  reg.register("c", (c) => (c.built("zzz") ? mk("bad") : mk("c sees nothing")));
  const tools = reg.build(ctx(), {});
  expect(tools.b?.description).toBe("b sees a");
  expect(tools.c?.description).toBe("c sees nothing");
});

it("applies wrap to each tool as it is built, and built(name) returns the wrapped tool", () => {
  const wrap = (name: string, t: Tool): Tool => ({ ...t, description: `wrapped ${name}:${t.description}` });
  const reg = createToolRegistry(wrap);
  reg.register("a", () => mk("a"));
  reg.register("b", (c) => mk(`b saw ${c.built("a")?.description}`));
  const tools = reg.build(ctx(), { m: mk("m") });
  expect(tools.a?.description).toBe("wrapped a:a");
  expect(tools.b?.description).toBe("wrapped b:b saw wrapped a:a");
  expect(tools.m?.description).toBe("m");
});

it("refuses to register a name twice", () => {
  const reg = createToolRegistry();
  reg.register("a", () => mk("a"));
  expect(() => reg.register("a", () => mk("a2"))).toThrow(/already registered/);
});

it("gives a custom tool call(name, input): a built-in runs with the id <outer>:call-<n>", async () => {
  const seen: string[] = [];
  const echo = tool({ description: "e", inputSchema: z.object({ v: z.string() }), execute: async ({ v }, o) => (seen.push(o.toolCallId), `got ${v}`) });
  const reg = createToolRegistry();
  reg.register("echo", () => echo);
  reg.register("outer", (c) => tool({ description: "o", inputSchema: z.object({}), execute: async () => [await c.call("echo", { v: "1" }), await c.call("echo", { v: "2" })].join() }), { custom: true });
  const tools = reg.build(ctx(), {});
  const out = await tools.outer!.execute!({}, { toolCallId: "T1", messages: [] });
  expect(out).toBe("got 1,got 2");
  expect(seen).toEqual(["T1:call-1", "T1:call-2"]);
});

it("call refuses a custom tool, a tool without execute, an unbuilt name and an unknown name", async () => {
  const noExec = tool({ description: "n", inputSchema: z.object({}) });
  const reg = createToolRegistry();
  reg.register("ask", () => noExec);
  reg.register("unbuilt", () => undefined);
  reg.register("custom", () => mk("c"), { custom: true });
  reg.register("outer", (c) => tool({ description: "o", inputSchema: z.object({ n: z.string() }), execute: async ({ n }) => c.call(n, {}) }), { custom: true });
  const tools = reg.build(ctx(), {});
  for (const n of ["ask", "unbuilt", "custom", "outer", "nope"]) {
    await expect(tools.outer!.execute!({ n }, { toolCallId: "T", messages: [] })).rejects.toThrow(`call("${n}")`);
  }
});
