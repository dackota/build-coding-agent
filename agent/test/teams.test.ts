// platform/teams.sh reads the one team list (platform/teams.txt) for make up and make status.
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { PLATFORM_DIR } from "./chart-helpers.ts";

function teamsFile(content: string): string {
  const file = join(mkdtempSync(join(tmpdir(), "teams-")), "teams.txt");
  writeFileSync(file, content);
  return file;
}

function teamsSh(file: string, ...args: string[]) {
  const res = spawnSync("bash", [join(PLATFORM_DIR, "teams.sh"), ...args], { encoding: "utf8", env: { PATH: process.env.PATH ?? "", TEAMS_FILE: file } });
  return { code: res.status, stdout: res.stdout, stderr: res.stderr };
}

describe("teams.sh", () => {
  it("lists the team names, skipping comments and blank lines", () => {
    const r = teamsSh(teamsFile("# the teams\nplatform\n\n  payments  \n"), "names");
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toBe("platform\npayments\n");
  });

  it("fails on a team name in the wrong format and names it", () => {
    const r = teamsSh(teamsFile("platform\nBad_Team\n"), "names");
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain("Bad_Team");
  });

  it("fails on a duplicate team", () => {
    const r = teamsSh(teamsFile("platform\nplatform\n"), "names");
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain("platform");
  });

  it("fails on an empty team list", () => {
    const r = teamsSh(teamsFile("# none yet\n"), "names");
    expect(r.code).not.toBe(0);
  });

  it("writes Substrate namespace policies for kagent and every team", () => {
    const r = teamsSh(teamsFile("platform\npayments\n"), "substrate-values");
    expect(r.code, r.stderr).toBe(0);
    expect(parse(r.stdout)).toEqual({
      credentialProvider: {
        namespacePolicies: [
          { atespace: "kagent", allowedNamespaces: ["kagent"] },
          { atespace: "team-platform", allowedNamespaces: ["team-platform"] },
          { atespace: "team-payments", allowedNamespaces: ["team-payments"] },
        ],
      },
    });
  });

  it("the repo's team list has the platform team", () => {
    const r = teamsSh(join(PLATFORM_DIR, "teams.txt"), "names");
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout.split("\n")).toContain("platform");
  });
});
