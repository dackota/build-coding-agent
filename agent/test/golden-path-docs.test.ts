// The golden path docs: README table, guard rails with proofs, five ADRs, glossary, Later list.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { REPO_ROOT } from "./chart-helpers.ts";

const read = (...p: string[]): string => {
  const f = join(REPO_ROOT, ...p);
  return existsSync(f) ? readFileSync(f, "utf8") : "";
};

describe("README", () => {
  const readme = read("README.md");
  it.each([
    ["dev guide", "docs/dev-guide.md"],
    ["guard rails", "docs/guard-rails.md"],
    ["byo contract", "docs/byo-contract.md"],
  ])("table links the %s", (_n, target) => {
    const rows = readme.split("\n").filter((l) => l.startsWith("|") && l.includes(`](${target})`));
    expect(rows.length, `no table row links ${target}`).toBeGreaterThan(0);
    expect(existsSync(join(REPO_ROOT, target))).toBe(true);
  });
});

describe("docs/guard-rails.md", () => {
  const doc = read("docs", "guard-rails.md");
  const rows = doc
    .split("\n")
    .filter((l) => /^\| \*\*/.test(l));

  it("lists the rails", () => {
    expect(rows.length).toBeGreaterThanOrEqual(8);
  });

  it.each(rows.map((r) => [r.split("|")[1]!.trim(), r] as const))(
    "rail %s links a proof that exists in the repo",
    (_name, row) => {
      const proofCell = row.split("|")[3] ?? "";
      const links = [...proofCell.matchAll(/\]\(([^)#]+)(?:#[^)]*)?\)/g)].map((m) => m[1]!);
      expect(links.length, "no link in the proof cell").toBeGreaterThan(0);
      for (const l of links) {
        expect(existsSync(join(REPO_ROOT, "docs", l)), `missing ${l}`).toBe(true);
      }
    },
  );

  it("links the byo contract", () => {
    expect(doc).toContain("](byo-contract.md)");
  });
});

describe("ADRs", () => {
  const ADRS: [string, RegExp][] = [
    ["values-file", /values-file/i],
    ["token-caps", /token caps/i],
    ["minter", /minter/i],
    ["team", /namespace/i],
    ["mcp-auth", /MCP authorization/i],
  ];
  const files = readdirSync(join(REPO_ROOT, "docs", "decisions"));
  it.each(ADRS)("ADR %s exists and names the option that lost", (key, title) => {
    const f = files.find((n) => /^000[4-9]-/.test(n) && n.includes(key.split("-")[0]!));
    expect(f, `no ADR file for ${key}`).toBeDefined();
    const text = read("docs", "decisions", f!);
    expect(text.split("\n")[0]).toMatch(title);
    expect(text).toMatch(/^## Option that lost\n+\S/m);
  });
});

describe("glossary", () => {
  const g = read("docs", "GLOSSARY.md");
  it.each(["Team", "Team base", "Values file", "Catalog tool", "Registration", "Minter", "Agent key", "Token cap"])(
    "defines %s",
    (term) => {
      expect(g).toContain(`**${term}**:`);
    },
  );
  it("keeps Harness, not runtime for the kagent object", () => {
    expect(g).toMatch(/\*\*Harness\*\*:[\s\S]*?_Avoid_: runtime/);
  });
});

describe("no doc sends a team to hand-written kagent YAML", () => {
  const dirs = ["README.md", "docs", "deployments/README.md"];
  const files: string[] = [];
  const walk = (rel: string): void => {
    const abs = join(REPO_ROOT, rel);
    if (!existsSync(abs)) return;
    if (abs.endsWith(".md")) files.push(rel);
    else for (const e of readdirSync(abs, { withFileTypes: true })) if (e.isDirectory() || e.name.endsWith(".md")) walk(join(rel, e.name));
  };
  dirs.forEach(walk);
  it("finds the docs", () => expect(files.length).toBeGreaterThan(5));
  it("has no hit", () => {
    // an ADR may describe the rejected option
    const bad = files.filter((f) => !f.includes("decisions") && /\bhand-writ(e|ten) kagent/i.test(read(f)));
    expect(bad).toEqual([]);
  });
  it("the dev guide tells a team to write a values file", () => {
    expect(read("docs", "dev-guide.md")).toMatch(/deployments\/<team>\/<agent>\/values\.yaml/);
  });
});

describe("docs/later.md", () => {
  const later = read("docs", "later.md");
  it.each([
    "real operator",
    "cosign",
    "GitHub App",
    "evals",
    "observability",
    "A2A between agents",
  ])("lists %s with a why", (item) => {
    const line = later.split("\n").find((l) => l.startsWith("- ") && l.toLowerCase().includes(item.toLowerCase()));
    expect(line, `no bullet for ${item}`).toBeDefined();
    expect(line).toMatch(/Why: \S/);
  });
});
