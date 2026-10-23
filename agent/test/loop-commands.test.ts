import { describe, expect, it } from "vitest";
import { findCommands } from "../src/loop-commands.ts";

const pkg = (scripts: Record<string, string>, extra: object = {}) => JSON.stringify({ name: "x", scripts, ...extra });

describe("finding the setup and test commands", () => {
  it("takes the test script of package.json, with no setup when there are no dependencies", () => {
    expect(findCommands({ packageJson: pkg({ test: "node --test" }), files: ["package.json"] })).toEqual({ setup: undefined, test: "npm test" });
  });

  it("installs from the lockfile the project has", () => {
    const deps = { devDependencies: { vitest: "1" } };
    expect(findCommands({ packageJson: pkg({ test: "vitest run" }, deps), files: ["package.json", "package-lock.json"] }).setup).toBe("npm ci");
    expect(findCommands({ packageJson: pkg({ test: "vitest run" }, deps), files: ["package.json", "pnpm-lock.yaml"] })).toEqual({
      setup: "pnpm install --frozen-lockfile",
      test: "pnpm test",
    });
    expect(findCommands({ packageJson: pkg({ test: "vitest run" }, deps), files: ["package.json"] }).setup).toBe("npm install");
  });

  it("prefers the commands AGENTS.md names", () => {
    const agentsMd = "# Rules\n- Setup: `make deps`\n- Test: `make check`\n";
    expect(findCommands({ agentsMd, packageJson: pkg({ test: "node --test" }), files: ["package.json"] })).toEqual({ setup: "make deps", test: "make check" });
  });

  it("takes commands the approved plan names before AGENTS.md", () => {
    const plan = "Proof:\n- Test: `make plan-check`\n";
    const agentsMd = "- Setup: `make deps`\n- Test: `make check`\n";
    expect(findCommands({ plan, agentsMd, files: [] })).toEqual({ setup: "make deps", test: "make plan-check" });
  });

  it("finds no test command when none is named, and ignores npm's placeholder script", () => {
    expect(findCommands({ files: ["README.md"] })).toEqual({ setup: undefined, test: undefined });
    expect(findCommands({ packageJson: pkg({ test: 'echo "Error: no test specified" && exit 1' }), files: ["package.json"] }).test).toBeUndefined();
    expect(findCommands({ packageJson: "not json", files: ["package.json"] }).test).toBeUndefined();
  });
});
