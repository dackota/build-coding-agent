// What a turn changed in the workspace, as a unified diff. The file tools record each file's
// content before their first write in the turn; the diff compares that with the file now.
import { createTwoFilesPatch } from "diff";
import { readIfExists, relativeInWorkspace, type Sandbox } from "./sandbox.ts";

/** Workspace-relative path to its content before the turn's first write, or null when it did not exist. */
export type Baseline = Record<string, string | null>;

export class ChangeTracker {
  private readonly before = new Map<string, string | null>();

  constructor(baseline: Baseline = {}) {
    for (const [path, content] of Object.entries(baseline)) this.before.set(path, content);
  }

  /** Call before every write: only the first call for a path keeps its content. */
  async recordBefore(sandbox: Sandbox, path: string): Promise<void> {
    const key = relativeInWorkspace(path);
    if (this.before.has(key)) return;
    let content: string | null;
    try {
      content = await sandbox.readFile(key);
    } catch (err) {
      // Node sets code ENOENT; just-bash says so in the message.
      const isMissing = (err as NodeJS.ErrnoException).code === "ENOENT" || /ENOENT/.test((err as Error).message);
      if (!isMissing) throw err;
      content = null;
    }
    this.before.set(key, content);
  }

  baseline(): Baseline {
    return Object.fromEntries(this.before);
  }

  /** A git-style unified diff (a/ and b/ prefixes) of every changed file, sorted by path; "" when nothing changed. */
  async diff(sandbox: Sandbox): Promise<string> {
    const patches: string[] = [];
    for (const path of [...this.before.keys()].sort()) {
      const old = this.before.get(path) ?? null;
      const now = (await readIfExists(sandbox, path)) ?? null;
      if (old === now) continue;
      const patch = createTwoFilesPatch(old === null ? "/dev/null" : `a/${path}`, now === null ? "/dev/null" : `b/${path}`, old ?? "", now ?? "", "", "");
      // jsdiff opens each patch with a "====" rule; unified diff tools do not need it.
      patches.push(patch.replace(/^=+\n/, ""));
    }
    return patches.join("");
  }
}
