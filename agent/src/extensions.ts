// Extensions: trusted operator modules baked into the image. Each default-exports a setup
// function that gets the extension API. They load once at startup; any fault stops startup.
import { readdirSync, realpathSync, statSync } from "node:fs";
import { join, relative, resolve, isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";
import type { ToolFactory } from "./tool-registry.ts";
import { log } from "./log.ts";

export type ExtensionApi = {
  /** Adds a custom tool, after the built-ins. The factory runs each turn; it gets the turn's context (`sandbox` among it). */
  registerTool(name: string, factory: ToolFactory): void;
};

export type LoadedExtension = {
  /** The module's file name. */
  file: string;
  tools: { name: string; factory: ToolFactory }[];
};

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
    const api: ExtensionApi = { registerTool: (name, factory) => void tools.push({ name, factory }) };
    try {
      await mod.default(api);
    } catch (err) {
      throw new Error(`extension ${file} threw in setup: ${(err as Error).message}`);
    }
    loaded.push({ file, tools });
  }
  return loaded;
}

/** Registers each extension's tools, after the built-ins. A taken name stops startup, naming the tool and the file. */
export function registerExtensionTools(
  registry: { register(name: string, factory: ToolFactory): void; names(): string[] },
  extensions: readonly LoadedExtension[],
): void {
  for (const ext of extensions) {
    for (const { name, factory } of ext.tools) {
      if (registry.names().includes(name)) throw new Error(`extension ${ext.file}: tool ${JSON.stringify(name)} is already registered`);
      registry.register(name, factory);
    }
    log("extension-loaded", { extension: ext.file, tools: ext.tools.map((t) => t.name).join(",") });
  }
}
