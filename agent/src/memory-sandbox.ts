// The in-memory Sandbox, for tests: just-bash over a copy-on-write overlay of a real directory.
// Reads see the directory; writes stay in memory and leave the disk as it was.
// just-bash is a dev dependency, so only a test run (AGENT_SANDBOX=memory) loads this file.
import { mkdir } from "node:fs/promises";
import { Bash, OverlayFs } from "just-bash";
import { OutsideWorkspaceError, relativeInWorkspace, type Sandbox } from "./sandbox.ts";

const MOUNT = "/workspace";

export async function createMemorySandbox(root: string): Promise<Sandbox> {
  // The overlay needs its lower directory to exist; it stays empty unless the test seeds it.
  await mkdir(root, { recursive: true });
  const fs = new OverlayFs({ root, mountPoint: MOUNT });
  const bash = new Bash({ fs, cwd: MOUNT });

  /** The virtual path for `path`; refuses any symlink on the way (the overlay would refuse it too, less clearly). */
  async function resolve(path: string): Promise<string> {
    const segments = relativeInWorkspace(path).split("/");
    let current = MOUNT;
    for (const segment of segments) {
      current = `${current}/${segment}`;
      let isLink: boolean;
      try {
        isLink = (await fs.lstat(current)).isSymbolicLink;
      } catch {
        break;
      }
      if (isLink) throw new OutsideWorkspaceError(path);
    }
    return `${MOUNT}/${segments.join("/")}`;
  }

  return {
    async readFile(path) {
      return fs.readFile(await resolve(path), "utf8");
    },
    async writeFile(path, content) {
      const full = await resolve(path);
      await fs.mkdir(full.slice(0, full.lastIndexOf("/")), { recursive: true });
      await fs.writeFile(full, content, "utf8");
    },
    async exec(command) {
      const { stdout, stderr, exitCode } = await bash.exec(command, { cwd: MOUNT });
      return { stdout, stderr, exitCode };
    },
    async stop() {},
  };
}
