import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const platform = (name: string): string => readFileSync(resolve(import.meta.dirname, "../../platform", name), "utf8");

const docs = (): string[] => platform("triage-agent.yaml").split(/^---$/m);
const doc = (kind: string): string => {
  const found = docs().find((d) => new RegExp(`^kind: ${kind}$`, "m").test(d));
  if (found === undefined) throw new Error(`no ${kind} in triage-agent.yaml`);
  return found;
};

describe("triage-agent manifest", () => {
  it("defines a triage-agent AgentTemplate and an Agent on kagent-stock", () => {
    expect(doc("AgentTemplate")).toMatch(/name: triage-agent\b/);
    expect(doc("Agent")).toMatch(/name: triage-agent\b/);
    expect(doc("Agent")).toMatch(/harnessRef: \{name: kagent-stock\}/);
    expect(doc("Agent")).toMatch(/ref: \{name: triage-agent\}/);
  });

  it("binds only github-mcp issue_read, with no other tool", () => {
    const template = doc("AgentTemplate");
    expect(template.match(/^\s*- mcp:/gm)).toHaveLength(1);
    expect(template).not.toMatch(/subAgent|requireApproval|^\s*- agent:/m);
    expect(template).toMatch(/server: \{kind: RemoteMCPServer, name: github-mcp\}/);
    expect(template).toMatch(/tools: \[issue_read\]/);
    for (const write of ["create_branch", "push_files", "create_pull_request"]) {
      expect(template).not.toContain(write);
    }
  });

  it("holds no token, env, or headers", () => {
    const all = platform("triage-agent.yaml");
    expect(all).not.toMatch(/\benv:|headers|secretKeyRef|GITHUB_TOKEN|OPENCODE|ghp_|github_pat_/i);
    expect(all).not.toMatch(/egressPolicyRefs/);
  });

  it("prompt names the three decisions and docs only", () => {
    const template = doc("AgentTemplate");
    for (const phrase of ["ready, build it", "needs a plan", "too big, split it", "docs only"]) {
      expect(template).toContain(phrase);
    }
  });
});

describe("triage-agent wiring", () => {
  it("deploy.sh applies platform/triage-agent.yaml and waits for it Ready", () => {
    const deploy = platform("deploy.sh");
    expect(deploy).toMatch(/apply -f "\$PLATFORM_DIR\/triage-agent\.yaml"/);
    expect(deploy).toMatch(/wait --for=condition=Ready agent\/triage-agent/);
  });

  it("status.sh reports triage-agent", () => {
    expect(platform("status.sh")).toMatch(/check_agent triage-agent/);
  });
});
