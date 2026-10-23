// Finds the setup and test commands of a repo: the ones AGENTS.md names, else what package.json
// and the lockfiles imply. Pure: the caller reads the files.

export type CommandSources = {
  agentsMd?: string | undefined;
  packageJson?: string | undefined;
  /** The names of the files at the repo root. */
  files: string[];
};
export type Commands = { setup: string | undefined; test: string | undefined };

const NPM_PLACEHOLDER = /no test specified/;

/** The `command` in a line like "- Test: `make check`" (the label is matched case-insensitively). */
function fromAgentsMd(agentsMd: string | undefined, labels: string): string | undefined {
  const pattern = new RegExp(`^\\s*(?:[-*]\\s*)?\\**(?:${labels})(?:\\s+command)?\\**\\s*:\\s*\`([^\`]+)\``, "im");
  return agentsMd ? pattern.exec(agentsMd)?.[1]?.trim() : undefined;
}

type Manifest = { scripts?: { test?: unknown }; dependencies?: object; devDependencies?: object } | undefined;

function parseManifest(json: string | undefined): Manifest {
  if (!json) return undefined;
  try {
    const parsed: unknown = JSON.parse(json);
    return parsed !== null && typeof parsed === "object" ? (parsed as Manifest) : undefined;
  } catch {
    return undefined;
  }
}

function packageManager(files: string[]): "pnpm" | "yarn" | "npm" {
  if (files.includes("pnpm-lock.yaml")) return "pnpm";
  if (files.includes("yarn.lock")) return "yarn";
  return "npm";
}

function installFor(manifest: Manifest, files: string[]): string | undefined {
  const hasDependencies = Object.keys(manifest?.dependencies ?? {}).length + Object.keys(manifest?.devDependencies ?? {}).length > 0;
  if (!hasDependencies) return undefined;
  const manager = packageManager(files);
  if (manager === "pnpm") return "pnpm install --frozen-lockfile";
  if (manager === "yarn") return "yarn install --frozen-lockfile";
  return files.includes("package-lock.json") ? "npm ci" : "npm install";
}

export function findCommands(sources: CommandSources): Commands {
  const manifest = parseManifest(sources.packageJson);
  const script = manifest?.scripts?.test;
  const hasTestScript = typeof script === "string" && script.trim() !== "" && !NPM_PLACEHOLDER.test(script);
  const impliedTest = hasTestScript ? `${packageManager(sources.files)} test` : undefined;
  return {
    setup: fromAgentsMd(sources.agentsMd, "setup|install") ?? installFor(manifest, sources.files),
    test: fromAgentsMd(sources.agentsMd, "tests?") ?? impliedTest,
  };
}
