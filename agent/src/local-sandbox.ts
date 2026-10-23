import { execFile } from "node:child_process";
import { lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { dirname, join, sep } from "node:path";
import { type ExecResult, OutsideWorkspaceError, relativeInWorkspace, type Sandbox } from "./sandbox.ts";

export const EXEC_TIMEOUT_MS = 60_000;
const EXEC_MAX_BUFFER = 1024 * 1024;
// A command has no terminal: git must fail on a repo that wants a login, not wait for a prompt.
const EXEC_ENV = { ...process.env, GIT_TERMINAL_PROMPT: "0" };

const isInside = (root: string, path: string) => path === root || path.startsWith(root + sep);

/** The workspace as a real directory, with Node fs and child_process: what the agent's actor uses. */
export async function createLocalSandbox(root: string, opts: { execTimeoutMs?: number } = {}): Promise<Sandbox> {
  const execTimeoutMs = opts.execTimeoutMs ?? EXEC_TIMEOUT_MS;
  await mkdir(root, { recursive: true });
  const realRoot = await realpath(root);

  /** The real path for `path`, after checking that it, or its nearest existing ancestor, resolves inside the workspace. */
  async function resolve(path: string): Promise<string> {
    const full = join(realRoot, relativeInWorkspace(path));
    let probe = full;
    for (;;) {
      try {
        await lstat(probe);
        break;
      } catch {
        probe = dirname(probe);
      }
    }
    // realpath follows every symlink on the way, so a link out (to a dir or a file) lands outside.
    if (!isInside(realRoot, await realpath(probe))) throw new OutsideWorkspaceError(path);
    return full;
  }

  return {
    async readFile(path) {
      return readFile(await resolve(path), "utf8");
    },
    async writeFile(path, content) {
      const full = await resolve(path);
      await mkdir(dirname(full), { recursive: true });
      // Check again after mkdir: the new directories are real, so the target resolves the same way.
      await resolve(path);
      await writeFile(full, content);
    },
    exec(command, opts) {
      return new Promise<ExecResult>((done) => {
        execFile("/bin/sh", ["-c", command], { cwd: realRoot, env: EXEC_ENV, timeout: opts?.timeoutMs ?? execTimeoutMs, maxBuffer: EXEC_MAX_BUFFER }, (err, stdout, stderr) => {
          const code = err ? (typeof err.code === "number" ? err.code : 1) : 0;
          done({ stdout, stderr, exitCode: code, ...(err?.killed ? { hasTimedOut: true } : {}) });
        });
      });
    },
    async stop() {},
  };
}
