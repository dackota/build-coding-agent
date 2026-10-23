// Extensions: trusted operator modules baked into the image. Each default-exports a setup
// function that gets the extension API. They load once at startup; any fault stops startup.
import { readdirSync, realpathSync, statSync } from "node:fs";
import { join, relative, resolve, isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";
import type { Tool } from "ai";
import { capOutput } from "./context.ts";
import type { ToolFactory, ToolWrap } from "./tool-registry.ts";
import { log } from "./log.ts";

/** A `tool_call` handler's answer: return nothing to let the call go on (watch), or block it with a reason the model gets. */
export type ToolCallResult = { block: true; reason: string };
export type ToolCallHandler = (e: { toolName: string; input: unknown }) => Promise<ToolCallResult | void>;

export type ExtensionApi = {
  /** Adds a custom tool, after the built-ins. The factory runs each turn; it gets the turn's context (`sandbox` among it, and `call(name, input)` to run a built-in tool). */
  registerTool(name: string, factory: ToolFactory): void;
  /** Subscribes to a lifecycle event. `tool_call` runs before every tool call with an `execute`, in extension load order. */
  on(event: "tool_call", handler: ToolCallHandler): void;
};

export type LoadedExtension = {
  /** The module's file name. */
  file: string;
  /** The file name without `.ts`: what a block reason and a failure name. */
  name: string;
  tools: { name: string; factory: ToolFactory }[];
  /** The extension's `tool_call` handlers, in the order it subscribed them. */
  toolCall: ToolCallHandler[];
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
    const api: ExtensionApi = {
      registerTool: (name, factory) => void tools.push({ name, factory }),
      on: (event, handler) => {
        if (event !== "tool_call") throw new Error(`unknown event ${JSON.stringify(event)}`);
        if (typeof handler !== "function") throw new Error(`the ${event} handler is not a function`);
        toolCall.push(handler);
      },
    };
    try {
      await mod.default(api);
    } catch (err) {
      throw new Error(`extension ${file} threw in setup: ${(err as Error).message}`);
    }
    loaded.push({ file, name: file.replace(EXTENSION_FILE, ""), tools, toolCall });
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
    const events: Record<string, string> = ext.toolCall.length > 0 ? { events: "tool_call" } : {};
    log("extension-loaded", { extension: ext.file, tools: ext.tools.map((t) => t.name).join(","), ...events });
  }
}

/**
 * The registry's per-tool wrap: before a tool with an `execute` runs, every extension's
 * `tool_call` handlers run in load order. The first handler that blocks or throws ends the
 * chain and the tool does not run: a block becomes the tool's result
 * (`blocked by <extension>: <reason>`), a throw a tool error (`extension <name> failed on
 * tool_call`). `needsApproval` and the rest of the tool are kept, and `execute`'s options pass
 * through unchanged, so an approval pause comes before the handlers. Logs never carry input.
 */
export function eventWrap(extensions: readonly LoadedExtension[]): ToolWrap {
  const handlers = extensions.flatMap((ext) => ext.toolCall.map((handler) => ({ extension: ext.name, handler })));
  if (handlers.length === 0) return (_name, t) => t;
  return (toolName, t) => {
    const execute = t.execute;
    if (typeof execute !== "function") return t;
    return {
      ...t,
      execute: async (input: unknown, options: Parameters<typeof execute>[1]) => {
        for (const { extension, handler } of handlers) {
          const reason = await runHandler(extension, handler, toolName, input);
          if (reason === undefined) continue;
          log("extension-blocked", { tool: toolName, extension });
          return `blocked by ${extension}: ${reason}`;
        }
        return execute(input as never, options);
      },
    } as Tool;
  };
}

/** One handler's verdict: undefined to let the call go on, or the block reason. A throw, or an answer that is neither, fails closed. */
async function runHandler(extension: string, handler: ToolCallHandler, toolName: string, input: unknown): Promise<string | undefined> {
  let result: unknown;
  try {
    result = await handler({ toolName, input });
    if (result === undefined) return undefined;
    if (isBlock(result)) return result.reason;
    throw new Error("the handler returned something other than nothing or { block: true, reason }");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // `lifecycleEvent`, not `event`: the log line's own `event` key names the line.
    log("extension-failed", { lifecycleEvent: "tool_call", extension, message: capOutput(message, MAX_LOGGED_MESSAGE) });
    throw new Error(`extension ${extension} failed on tool_call`);
  }
}

function isBlock(result: unknown): result is ToolCallResult {
  if (typeof result !== "object" || result === null) return false;
  const r = result as { block?: unknown; reason?: unknown };
  return r.block === true && typeof r.reason === "string";
}
