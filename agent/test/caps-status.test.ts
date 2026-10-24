// platform/caps.sh, the token-cap lines of make status: each agent's and team's use against
// its cap, read from the ratelimit config and Redis's counters. kubectl is a stand-in on PATH.
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { PLATFORM_DIR } from "./chart-helpers.ts";

const month = (n: number) => ({ unit: "month", requests_per_unit: n });
const CONFIG = {
  domain: "agw",
  descriptors: [
    { key: "agent", value: "platform.hello-agent", rate_limit: month(1000000) },
    { key: "agent", value: "platform.docs-agent", rate_limit: month(2000) },
    { key: "team", value: "platform", rate_limit: month(50000000) },
  ],
};

/** A kubectl that answers the three calls caps.sh makes: the config, the counter keys, a counter. */
function fakeKubectl(config: string, counters: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "fake-kubectl-"));
  const file = join(dir, "kubectl");
  const cases = Object.entries(counters)
    .map(([k, v]) => (v === "__FAIL__" ? `  *"GET ${k}") echo "connection refused" >&2; exit 1 ;;` : `  *"GET ${k}") echo ${v} ;;`))
    .join("\n");
  writeFileSync(
    file,
    `#!/usr/bin/env bash
case "$*" in
  *"get configmap ratelimit-config"*) printf '%s' '${config}' ;;
  *"--scan"*) printf '%s\\n' ${Object.keys(counters).map((k) => `'${k}'`).join(" ")} ;;
${cases}
  *) echo "unexpected: $*" >&2; exit 1 ;;
esac
`,
  );
  chmodSync(file, 0o755);
  return dir;
}

function capsSh(bin: string) {
  const res = spawnSync("bash", [join(PLATFORM_DIR, "caps.sh")], { encoding: "utf8", env: { PATH: `${bin}:${process.env.PATH ?? ""}` } });
  return { code: res.status, stdout: res.stdout, stderr: res.stderr };
}

describe("caps.sh", () => {
  it("prints use against cap per agent and team", () => {
    const bin = fakeKubectl(JSON.stringify(CONFIG), {
      "agw_agent_platform.hello-agent_1000": "250000",
      "agw_agent_platform.docs-agent_1000": "2500",
      "agw_team_platform_1000": "5000000",
    });
    const r = capsSh(bin);
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout.trim().split("\n")).toEqual([
      "ok   tokens agent platform/docs-agent: 2500 of 2000 (125%, over its cap)",
      "ok   tokens agent platform/hello-agent: 250000 of 1000000 (25%)",
      "ok   tokens team platform: 5000000 of 50000000 (10%)",
    ]);
  });

  it("counts an agent with no counter yet as zero, and reads the newest counter window", () => {
    const bin = fakeKubectl(JSON.stringify(CONFIG), { "agw_agent_platform.hello-agent_1000": "9", "agw_agent_platform.hello-agent_2000": "40" });
    const r = capsSh(bin);
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toContain("ok   tokens agent platform/hello-agent: 40 of 1000000 (0%)");
    expect(r.stdout).toContain("ok   tokens agent platform/docs-agent: 0 of 2000 (0%)");
    expect(r.stdout).toContain("ok   tokens team platform: 0 of 50000000 (0%)");
  });

  it("fails with a line when a counter cannot be read", () => {
    const r = capsSh(fakeKubectl(JSON.stringify(CONFIG), { agw_team_platform_1000: "__FAIL__" }));
    expect(r.code).not.toBe(0);
    expect(r.stdout).toMatch(/^FAIL tokens: cannot read counter agw_team_platform_1000/m);
  });

  it("fails with a line when the ratelimit config cannot be read", () => {
    const bin = fakeKubectl("", {});
    const r = capsSh(bin);
    expect(r.code).not.toBe(0);
    expect(r.stdout).toMatch(/^FAIL tokens: /m);
  });
});
