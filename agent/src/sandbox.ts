// The swap point between the file tools and where the code lives. The local Sandbox works on
// a directory under the data dir (inside the agent's own actor); the in-memory one is for tests.
import { posix } from "node:path";
import { log } from "./log.ts";

export type ExecResult = { stdout: string; stderr: string; exitCode: number; /** True when the command was killed for running too long. */ hasTimedOut?: boolean };

export type SandboxHooks = {
  afterStart?: (sandbox: Sandbox) => void | Promise<void>;
  beforeStop?: (sandbox: Sandbox) => void | Promise<void>;
  onTimeout?: (command: string) => void | Promise<void>;
};

export interface Sandbox {
  /** Reads a file by its workspace-relative path. */
  readFile(path: string): Promise<string>;
  /** Writes a file by its workspace-relative path, creating parent directories. Text is written as UTF-8; bytes as they are. */
  writeFile(path: string, content: string | Uint8Array): Promise<void>;
  /** Runs a shell command with the workspace as its working directory. `timeoutMs` replaces the sandbox's own limit for this call. */
  exec(command: string, opts?: { timeoutMs?: number }): Promise<ExecResult>;
  stop(): Promise<void>;
}

export class OutsideWorkspaceError extends Error {
  constructor(path: string) {
    super(`path ${JSON.stringify(path)} is outside the workspace: use a path relative to the workspace root, with no "..", and no symlink out`);
    this.name = "OutsideWorkspaceError";
  }
}

const MAX_PATH_LENGTH = 4096;

/**
 * The workspace-relative, normalized form of `path`, or an OutsideWorkspaceError. Absolute
 * paths, any ".." that climbs out, NUL bytes, and backslashes are refused. Symlinks are each
 * implementation's job: only it can see the real files.
 */
export function relativeInWorkspace(path: string): string {
  if (typeof path !== "string" || path === "" || path.length > MAX_PATH_LENGTH) throw new OutsideWorkspaceError(String(path));
  if (path.includes("\0") || path.includes("\\") || posix.isAbsolute(path)) throw new OutsideWorkspaceError(path);
  const normalized = posix.normalize(path);
  if (normalized === ".." || normalized.startsWith("../")) throw new OutsideWorkspaceError(path);
  if (normalized === "." || normalized === "./") throw new OutsideWorkspaceError(path);
  return normalized.replace(/\/+$/, "");
}

/** Single-quotes a value for a POSIX shell. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Wraps a Sandbox with lifecycle hooks. afterStart has finished before this returns, so before
 * any use; beforeStop runs once, before the first stop reaches the sandbox, however often stop
 * is called; onTimeout runs after each command the sandbox reports as timed out. A beforeStop that
 * throws is logged and never blocks the stop.
 */
export async function withHooks(sandbox: Sandbox, hooks: SandboxHooks): Promise<Sandbox> {
  await hooks.afterStart?.(sandbox);
  let stopping: Promise<void> | undefined;
  return {
    readFile: (path) => sandbox.readFile(path),
    writeFile: (path, content) => sandbox.writeFile(path, content),
    async exec(command, opts) {
      const result = await sandbox.exec(command, opts);
      if (result.hasTimedOut) await hooks.onTimeout?.(command);
      return result;
    },
    stop() {
      stopping ??= (async () => {
        try {
          await hooks.beforeStop?.(sandbox);
        } catch (err) {
          log("hook-failed", { hook: "beforeStop", message: (err as Error).message });
        }
        await sandbox.stop();
      })();
      return stopping;
    },
  };
}

/** The file's text, or undefined when it does not exist. Any other failure (outside the workspace, permissions) is thrown. */
export async function readIfExists(sandbox: Sandbox, path: string): Promise<string | undefined> {
  try {
    return await sandbox.readFile(path);
  } catch (err) {
    // The in-memory sandbox (just-bash) sets no `code`, only the message prefix.
    const e = err as NodeJS.ErrnoException;
    if (e.code === "ENOENT" || (e.code === undefined && e.message.startsWith("ENOENT:"))) return undefined;
    throw err;
  }
}
