// The platform team's own agents are values files (deployments/platform/<agent>), deployed
// by Argo CD into team-platform like any team's. The namespace `agents` and its hand-written
// YAML are gone: nothing in the platform scripts, manifests or docs names it.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { AGENT_CHART, find, PLATFORM_DIR, REPO_ROOT, render, valuesFile, type K8sObject } from "./chart-helpers.ts";

const NS = "team-platform";
const SKILL_IMAGE = `172.18.0.3:5000/docs-skill@sha256:${"d".repeat(64)}`;
const PLATFORM_VALUES = valuesFile({ platform: { skillImages: { "docs-style": SKILL_IMAGE } } });
const valuesOf = (agent: string): string => join(REPO_ROOT, "deployments", "platform", agent, "values.yaml");

function renderAgent(agent: string): { template: K8sObject; agent: K8sObject } {
  const r = render(AGENT_CHART, agent, NS, [valuesOf(agent), PLATFORM_VALUES]);
  expect(r.ok, r.output).toBe(true);
  return { template: find(r.objects, "AgentTemplate", agent, NS)!, agent: find(r.objects, "Agent", agent, NS)! };
}

describe("platform team agents", () => {
  it("the platform team has exactly hello-agent, docs-agent and triage-agent", () => {
    expect(readdirSync(join(REPO_ROOT, "deployments", "platform")).sort()).toEqual(["docs-agent", "hello-agent", "triage-agent"]);
  });

  it("hello-agent runs on coding with the three subagents, github-write and demo-delete-branch behind approval", () => {
    const { template, agent } = renderAgent("hello-agent");
    expect(agent.spec.harnessRef).toEqual({ name: "coding" });
    expect(agent.spec.egressPolicyRefs).toEqual([{ name: "git-egress" }, { name: "npm-egress" }]);
    const tools = template.spec.tools as { mcp?: { server: { name: string }; tools: string[]; requireApproval?: boolean }; subAgent?: { name: string } }[];
    expect(tools.filter((t) => t.mcp).map((t) => t.mcp)).toEqual([
      { server: { kind: "RemoteMCPServer", name: "github-mcp" }, tools: ["create_branch", "push_files", "create_pull_request"], requireApproval: true },
      { server: { kind: "RemoteMCPServer", name: "demo-mcp" }, tools: ["delete_branch"], requireApproval: true },
    ]);
    expect(tools.filter((t) => t.subAgent).map((t) => t.subAgent!.name)).toEqual(["explorer", "executor", "reviewer"]);
    expect(template.spec.systemPrompt).toContain("create_pull_request");
  });

  it("docs-agent runs on coding with its docs-style skill and the explorer subagent", () => {
    const { template, agent } = renderAgent("docs-agent");
    expect(agent.spec.harnessRef).toEqual({ name: "coding" });
    expect(template.spec.skills).toEqual([{ name: "docs-style", source: { oci: SKILL_IMAGE } }]);
    expect(template.spec.tools).toEqual([
      { subAgent: { name: "explorer", description: expect.any(String), templateRef: { name: "explorer-template" } } },
    ]);
    expect(template.spec.systemPrompt).toMatch(/documentation/);
  });

  it("the docs-style skill a values file names exists in platform/skills", () => {
    expect(existsSync(join(PLATFORM_DIR, "skills", "docs-style", "SKILL.md"))).toBe(true);
  });
});

// The namespace `agents` in the forms the old manifests, scripts and docs used.
const AGENTS_NS = /namespace: agents\b|namespace `agents`|`agents` namespace|namespace agents\b|-n agents\b|\bAGENTS_NS\b|agents-default|atespace: agents\b|[\s`(]agents\/[a-z]/;

function filesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? filesUnder(path) : [path];
  });
}

describe("no namespace agents", () => {
  it("no platform script, chart or manifest names the agents namespace", () => {
    const files = [...filesUnder(PLATFORM_DIR), join(REPO_ROOT, "Makefile"), join(REPO_ROOT, ".env.example"), ...filesUnder(join(REPO_ROOT, "deployments"))];
    const hits = files.filter((f) => AGENTS_NS.test(readFileSync(f, "utf8"))).map((f) => relative(REPO_ROOT, f));
    expect(hits).toEqual([]);
  });

  it("no doc names the agents namespace", () => {
    const files = [...filesUnder(join(REPO_ROOT, "docs")), join(REPO_ROOT, "README.md"), join(REPO_ROOT, "agent", "README.md")];
    const hits = files.filter((f) => AGENTS_NS.test(readFileSync(f, "utf8"))).map((f) => relative(REPO_ROOT, f));
    expect(hits).toEqual([]);
  });

  it("the hand-written agent manifests are gone", () => {
    for (const name of ["agents.yaml", "agent.yaml.tmpl", "docs-agent.yaml", "triage-agent.yaml", "stock-agent.yaml", "egress.yaml"]) {
      expect(existsSync(join(PLATFORM_DIR, name)), name).toBe(false);
    }
  });

  it("make up deletes a leftover agents namespace", () => {
    expect(readFileSync(join(PLATFORM_DIR, "install.sh"), "utf8")).toMatch(/delete namespace "\$LEGACY_AGENTS_NS" --ignore-not-found/);
  });
});
