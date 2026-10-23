// Extensions: trusted operator modules baked into the image. Each default-exports a setup
// function that gets the extension API. They load once at startup; any fault stops startup.
import { readdirSync, realpathSync, statSync } from "node:fs";
import { join, relative, resolve, isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";
import { asSchema, type Tool } from "ai";
import { capOutput } from "./context.ts";
import type { ToolFactory, ToolWrap } from "./tool-registry.ts";
import { log } from "./log.ts";

/**
 * A `tool_call` handler's answer: return nothing to let the call go on (watch), block it with a
 * reason the model gets, or replace the input later handlers and the tool see.
 */
export type ToolCallResult = { block: true; reason: string } | { modify: { input: unknown } };
export type ToolCallHandler = (e: { toolName: string; input: unknown }) => Promise<ToolCallResult | void>;
/** A `tool_result` handler's answer: return nothing to keep the output, or replace it. */
export type ToolResultResult = { modify: { output: unknown } };
export type ToolResultHandler = (e: { toolName: string; input: unknown; output: unknown }) => Promise<ToolResultResult | void>;

export type ExtensionApi = {
  /** Adds a custom tool, after the built-ins. The factory runs each turn; it gets the turn's context (`sandbox` among it, and `call(name, input)` to run a built-in tool). */
  registerTool(name: string, factory: ToolFactory): void;
  /**
   * Subscribes to a lifecycle event, in extension load order: `tool_call` runs before every tool
   * call with an `execute`, `tool_result` after the tool ran.
   */
  on(event: "tool_call", handler: ToolCallHandler): void;
  on(event: "tool_result", handler: ToolResultHandler): void;
};

export type LoadedExtension = {
  /** The module's file name. */
  file: string;
  /** The file name without `.ts`: what a block reason and a failure name. */
  name: string;
  tools: { name: string; factory: ToolFactory }[];
  /** The extension's `tool_call` handlers, in the order it subscribed them. */
  toolCall: ToolCallHandler[];
  /** The extension's `tool_result` handlers, in the order it subscribed them. */
  toolResult: ToolResultHandler[];
};

/** Longest handler error message the log keeps. */
const MAX_LOGGED_MESSAGE = 300;

const EXTENSION_FILE = /\.ts$/;

function isUnder(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function realOrSelf(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

/** Loads every `.ts` module in `dir`, sorted by file name. Throws, naming the file or directory, on any fault. */
export async function loadExtensions(dir: string, dataDir: string): Promise<LoadedExtension[]> {
  let isDirectory = false;
  try {
    isDirectory = statSync(dir).isDirectory();
  } catch {
    // reported below
  }
  if (!isDirectory) throw new Error(`extensions directory ${JSON.stringify(dir)} does not exist or is not a directory`);
  if (isUnder(realOrSelf(dataDir), realOrSelf(dir))) throw new Error(`extensions directory ${JSON.stringify(dir)} is under the data directory, which the model can write`);
  const files = readdirSync(dir).filter((f) => EXTENSION_FILE.test(f)).sort();
  const loaded: LoadedExtension[] = [];
  for (const file of files) {
    const mod = (await import(pathToFileURL(join(dir, file)).href).catch((err: unknown) => {
      throw new Error(`extension ${file} failed to load: ${(err as Error).message}`);
    })) as { default?: unknown };
    if (typeof mod.default !== "function") throw new Error(`extension ${file} has no default function`);
    const tools: LoadedExtension["tools"] = [];
    const toolCall: ToolCallHandler[] = [];
    const toolResult: ToolResultHandler[] = [];
    const api: ExtensionApi = {
      registerTool: (name, factory) => void tools.push({ name, factory }),
      on: (event: string, handler: unknown) => {
        if (event !== "tool_call" && event !== "tool_result") throw new Error(`unknown event ${JSON.stringify(event)}`);
        if (typeof handler !== "function") throw new Error(`the ${event} handler is not a function`);
        if (event === "tool_call") toolCall.push(handler as ToolCallHandler);
        else toolResult.push(handler as ToolResultHandler);
      },
    };
    try {
      await mod.default(api);
    } catch (err) {
      throw new Error(`extension ${file} threw in setup: ${(err as Error).message}`);
    }
    loaded.push({ file, name: file.replace(EXTENSION_FILE, ""), tools, toolCall, toolResult });
  }
  return loaded;
}

/** Registers each extension's tools, after the built-ins. A taken name stops startup, naming the tool and the file. */
export function registerExtensionTools(
  registry: { register(name: string, factory: ToolFactory, opts?: { custom?: boolean }): void; names(): string[] },
  extensions: readonly LoadedExtension[],
): void {
  for (const ext of extensions) {
    for (const { name, factory } of ext.tools) {
      if (registry.names().includes(name)) throw new Error(`extension ${ext.file}: tool ${JSON.stringify(name)} is already registered`);
      registry.register(name, factory, { custom: true });
    }
    const subscribed = [ext.toolCall.length > 0 ? "tool_call" : "", ext.toolResult.length > 0 ? "tool_result" : ""].filter(Boolean);
    const events: Record<string, string> = subscribed.length > 0 ? { events: subscribed.join(",") } : {};
    log("extension-loaded", { extension: ext.file, tools: ext.tools.map((t) => t.name).join(","), ...events });
  }
}

type Named<H> = { extension: string; handler: H };

/**
 * The registry's per-tool wrap. Before a tool with an `execute` runs, every extension's
 * `tool_call` handlers run in load order. The first handler that blocks or throws ends the
 * chain and the tool does not run: a block becomes the tool's result
 * (`blocked by <extension>: <reason>`), a throw a tool error (`extension <name> failed on
 * tool_call`). A modify replaces the input for later handlers and the tool; it is checked
 * against the tool's input schema, and one the schema refuses is a tool error naming the
 * extension. After the tool runs, the `tool_result` handlers run in load order, each seeing the
 * previous output; the model gets the last. `needsApproval` and the rest of the tool are kept,
 * and `execute`'s options pass through unchanged, so an approval pause comes before the
 * handlers. Logs never carry input or output.
 */
export function eventWrap(extensions: readonly LoadedExtension[]): ToolWrap {
  const onCall = extensions.flatMap((ext) => ext.toolCall.map((handler) => ({ extension: ext.name, handler })));
  const onResult = extensions.flatMap((ext) => ext.toolResult.map((handler) => ({ extension: ext.name, handler })));
  if (onCall.length === 0 && onResult.length === 0) return (_name, t) => t;
  return (toolName, t) => {
    const execute = t.execute;
    if (typeof execute !== "function") return t;
    return {
      ...t,
      execute: async (input: unknown, options: Parameters<typeof execute>[1]) => {
        const call = await runToolCall(onCall, t, toolName, input);
        if ("blocked" in call) return call.blocked;
        const output: unknown = await execute(call.input as never, options);
        return runToolResult(onResult, toolName, call.input, output);
      },
    } as Tool;
  };
}

/** The `tool_call` chain: the input the tool gets, or the block text the model gets. */
async function runToolCall(handlers: readonly Named<ToolCallHandler>[], t: Tool, toolName: string, input: unknown): Promise<{ input: unknown } | { blocked: string }> {
  let current = input;
  for (const { extension, handler } of handlers) {
    const result = await runHandler("tool_call", extension, () => handler({ toolName, input: current }), parseToolCall);
    if (result === undefined) continue;
    if ("reason" in result) {
      log("extension-blocked", { tool: toolName, extension });
      return { blocked: `blocked by ${extension}: ${result.reason}` };
    }
    current = await checkedInput(t, toolName, extension, result.input);
  }
  return { input: current };
}

/** The `tool_result` chain: each handler sees the previous output; the last one stands. */
async function runToolResult(handlers: readonly Named<ToolResultHandler>[], toolName: string, input: unknown, output: unknown): Promise<unknown> {
  let current = output;
  for (const { extension, handler } of handlers) {
    const result = await runHandler("tool_result", extension, () => handler({ toolName, input, output: current }), parseToolResult);
    if (result !== undefined) current = result.output;
  }
  return current;
}

/** A modified input, checked against the tool's input schema; a refused one is a tool error naming the extension. */
async function checkedInput(t: Tool, toolName: string, extension: string, input: unknown): Promise<unknown> {
  const checked = await asSchema(t.inputSchema).validate?.(input);
  if (!checked) return input;
  if (checked.success) return checked.value;
  const forLog = capOutput(schemaProblem(checked.error, "log"), MAX_LOGGED_MESSAGE);
  log("extension-failed", { lifecycleEvent: "tool_call", extension, message: `invalid input: ${forLog}` });
  throw new Error(`extension ${extension} gave ${toolName} an invalid input: ${schemaProblem(checked.error, "model")}`);
}

type SchemaIssue = { path?: unknown[]; code?: unknown; message?: unknown };

/**
 * A schema error as `<field>: <problem>; ...` (zod issues carry the field path). For the model
 * the problem is the issue's message; for the log it is only the issue's code, because a zod
 * message can echo the received value (an enum's does) and log lines never carry tool input.
 */
function schemaProblem(error: Error, audience: "model" | "log"): string {
  const found = (error as { cause?: unknown }).cause ?? error;
  const issues = (found as { issues?: unknown }).issues;
  if (!Array.isArray(issues) || issues.length === 0) return audience === "model" ? error.message : "the schema refused it";
  return (issues as SchemaIssue[]).map((i) => `${(i.path ?? []).join(".") || "(input)"}: ${String(audience === "model" ? i.message : i.code)}`).join("; ");
}

/**
 * Runs one handler and parses its answer. A throw, or an answer the parser refuses, fails the
 * call closed with `extension <name> failed on <event>`; the log keeps the message.
 */
async function runHandler<R>(event: string, extension: string, run: () => Promise<unknown>, parse: (result: unknown) => R | undefined): Promise<R | undefined> {
  try {
    const result = await run();
    if (result === undefined) return undefined;
    const parsed = parse(result);
    if (parsed === undefined) throw new Error(`the handler returned something other than nothing or a ${event} answer`);
    return parsed;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // `lifecycleEvent`, not `event`: the log line's own `event` key names the line.
    log("extension-failed", { lifecycleEvent: event, extension, message: capOutput(message, MAX_LOGGED_MESSAGE) });
    throw new Error(`extension ${extension} failed on ${event}`);
  }
}

function parseToolCall(result: unknown): { reason: string } | { input: unknown } | undefined {
  if (typeof result !== "object" || result === null) return undefined;
  const r = result as { block?: unknown; reason?: unknown; modify?: unknown };
  if (r.block === true && typeof r.reason === "string") return { reason: r.reason };
  if (typeof r.modify === "object" && r.modify !== null && "input" in r.modify) return { input: (r.modify as { input: unknown }).input };
  return undefined;
}

function parseToolResult(result: unknown): { output: unknown } | undefined {
  if (typeof result !== "object" || result === null) return undefined;
  const modify = (result as { modify?: unknown }).modify;
  if (typeof modify === "object" && modify !== null && "output" in modify) return { output: (modify as { output: unknown }).output };
  return undefined;
}
