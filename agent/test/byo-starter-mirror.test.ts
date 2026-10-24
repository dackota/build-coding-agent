// The byo starter must be self-contained, so it holds copies of agent/src files. They change together.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { REPO_ROOT } from "./chart-helpers.ts";

const MIRRORED: [string, string][] = [
  ["early-listener.ts", "early-listener.ts"],
  ["readyz.ts", "readyz.ts"],
  ["log.ts", "log.ts"],
  ["wire.ts", "wire.ts"],
  ["controller-task-store.ts", "task-store.ts"],
];

describe("templates/byo-ts/src", () => {
  it.each(MIRRORED)("keeps %s identical to agent/src", (agentFile, starterFile) => {
    const agent = readFileSync(join(REPO_ROOT, "agent", "src", agentFile), "utf8");
    const starter = readFileSync(join(REPO_ROOT, "templates", "byo-ts", "src", starterFile), "utf8");
    expect(starter).toBe(agent);
  });
});
