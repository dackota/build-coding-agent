// triage-agent is a values file in the platform team (deployments/platform/triage-agent),
// rendered by the values-file chart as Argo CD renders it.
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { AGENT_CHART, find, REPO_ROOT, render, type K8sObject } from "./chart-helpers.ts";

const NS = "team-platform";
const VALUES = join(REPO_ROOT, "deployments", "platform", "triage-agent", "values.yaml");
const platform = (name: string): string => readFileSync(resolve(import.meta.dirname, "../../platform", name), "utf8");

function rendered(kind: string): K8sObject {
  const r = render(AGENT_CHART, "triage-agent", NS, [VALUES]);
  if (!r.ok) throw new Error(r.output);
  const found = find(r.objects, kind, "triage-agent", NS);
  if (!found) throw new Error(`no ${kind} triage-agent`);
  return found;
}
const prompt = (): string => rendered("AgentTemplate").spec.systemPrompt as string;

describe("triage-agent values file", () => {
  it("renders a triage-agent AgentTemplate and an Agent on kagent-stock in team-platform", () => {
    expect(rendered("Agent").spec).toEqual({ template: { ref: { name: "triage-agent" } }, harnessRef: { name: "kagent-stock" } });
  });

  it("binds only github-mcp issue_read, with no other tool and no approval", () => {
    expect(rendered("AgentTemplate").spec.tools).toEqual([{ mcp: { server: { kind: "RemoteMCPServer", name: "github-mcp" }, tools: ["issue_read"] } }]);
  });

  it("holds no token, env, or headers, and no egress", () => {
    const all = readFileSync(VALUES, "utf8");
    expect(all).not.toMatch(/\benv:|headers|secretKeyRef|GITHUB_TOKEN|OPENCODE|ghp_|github_pat_/i);
    expect(rendered("Agent").spec.egressPolicyRefs).toBeUndefined();
  });

  it("prompt names the three decisions and docs only", () => {
    for (const phrase of ["ready, build it", "needs a plan", "too big, split it", "docs only"]) {
      expect(prompt()).toContain(phrase);
    }
  });
});

describe("triage-agent hand-off", () => {
  it("prompt gives the exact hello-agent /implement command for ready and needs-a-plan", () => {
    expect(prompt()).toContain('AGENT=hello-agent make chat MSG="/implement <issue url>"');
    expect(prompt()).toMatch(/last line/i);
  });

  it("prompt gives docs-agent command for docs only", () => {
    expect(prompt()).toContain('AGENT=docs-agent make chat MSG="/implement <issue url>"');
  });

  it("prompt gives no command for too big", () => {
    expect(prompt()).toMatch(/too big[^]*no command/i);
  });

  it("using-the-agent.md shows the triage flow", () => {
    const guide = readFileSync(resolve(import.meta.dirname, "../../docs/using-the-agent.md"), "utf8");
    expect(guide).toContain("AGENT=triage-agent make chat");
    expect(guide).toContain('AGENT=hello-agent make chat MSG="/implement');
  });
});

describe("triage-agent wiring", () => {
  it("status.sh reports triage-agent", () => {
    expect(platform("status.sh")).toMatch(/check_agent triage-agent/);
  });
});
