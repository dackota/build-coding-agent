// The values-file chart (platform/charts/agent) is the contract a team writes against.
// Argo CD renders it per agent folder with the folder's name as the release name and
// team-<team> as the namespace; these tests render it the same way.
import { describe, expect, it } from "vitest";
import { AGENT_CHART, find, render, valuesFile } from "./chart-helpers.ts";

const STOCK = {
  name: "tracer",
  team: "platform",
  owner: "dackota",
  description: "A stock agent that answers briefly",
  runtime: "stock",
  model: "glm-5.3-flash",
  systemPrompt: "You are a concise, helpful assistant. Reply briefly.",
  tokenCap: 1_000_000,
};
const NS = "team-platform";

const renderValues = (values: unknown, release = "tracer", namespace = NS) => render(AGENT_CHART, release, namespace, [valuesFile(values)]);

function without<T extends object>(obj: T, key: keyof T): Partial<T> {
  return Object.fromEntries(Object.entries(obj).filter(([k]) => k !== key)) as Partial<T>;
}

describe("agent chart: stock runtime", () => {
  it("renders the AgentTemplate, Agent and registration ConfigMap for a stock values file", () => {
    const r = renderValues(STOCK);
    expect(r.ok, r.output).toBe(true);
    expect(r.objects.map((o) => `${o.kind}/${o.metadata.name}`).sort()).toEqual(["Agent/tracer", "AgentTemplate/tracer", "ConfigMap/tracer-registration", "ModelConfig/tracer-model"]);

    const template = find(r.objects, "AgentTemplate", "tracer", NS)!;
    expect(template.apiVersion).toBe("api.kagent.dev/v1alpha3");
    expect(template.spec).toEqual({
      description: "A stock agent that answers briefly",
      modelConfig: { name: "tracer-model" },
      systemPrompt: "You are a concise, helpful assistant. Reply briefly.",
    });

    const agent = find(r.objects, "Agent", "tracer", NS)!;
    expect(agent.apiVersion).toBe("api.kagent.dev/v1alpha3");
    expect(agent.spec).toEqual({ template: { ref: { name: "tracer" } }, harnessRef: { name: "kagent-stock" } });

    const registration = find(r.objects, "ConfigMap", "tracer-registration", NS)!;
    expect(registration.metadata.labels?.["agents.build-coding-agent.dev/registration"]).toBe("true");
    expect(registration.data).toEqual({ team: "platform", agent: "tracer", owner: "dackota", runtime: "stock", model: "glm-5.3-flash", tokenCap: "1000000" });
  });

  it("renders the agent's own ModelConfig naming its key Secret", () => {
    const r = renderValues(STOCK);
    expect(r.ok, r.output).toBe(true);
    const model = find(r.objects, "ModelConfig", "tracer-model", NS)!;
    expect(model.apiVersion).toBe("api.kagent.dev/v1alpha3");
    // The minter writes Secret tracer-agent-key; the actor gets only kagent's placeholder.
    expect(model.spec).toEqual({
      provider: "OpenAI",
      model: "glm-5.3-flash",
      apiKeySecret: "tracer-agent-key",
      apiKeySecretKey: "OPENAI_API_KEY",
      stream: true,
      openAI: { apiFormat: "chatCompletions", baseUrl: "http://agentgateway-proxy.agentgateway-system.svc.cluster.local/v1" },
    });
  });

  it("rejects a runtime outside the enum", () => {
    const r = renderValues({ ...STOCK, runtime: "python" });
    expect(r.ok).toBe(false);
    expect(r.output).toMatch(/runtime/);
  });

  it("refuses to render byo in this release", () => {
    const r = renderValues({ ...STOCK, runtime: "byo" });
    expect(r.ok).toBe(false);
    expect(r.output).toMatch(/runtime byo is not supported yet/);
  });

  it("refuses a values file whose team is not the namespace's team", () => {
    const r = renderValues(STOCK, "tracer", "team-payments");
    expect(r.ok).toBe(false);
    expect(r.output).toMatch(/team platform .* team-payments/);
  });

  it("refuses a values file whose name is not its folder's name", () => {
    const r = renderValues(STOCK, "other-folder");
    expect(r.ok).toBe(false);
    expect(r.output).toMatch(/name tracer .* other-folder/);
  });
});

describe("agent chart: schema negative cases", () => {
  it("rejects an unknown field", () => {
    const r = renderValues({ ...STOCK, systemPromt: "typo" });
    expect(r.ok).toBe(false);
    expect(r.output).toMatch(/systemPromt/);
  });

  it("rejects stock with no system prompt", () => {
    const r = renderValues(without(STOCK, "systemPrompt"));
    expect(r.ok).toBe(false);
    expect(r.output).toMatch(/systemPrompt/);
  });

  it("rejects an empty system prompt", () => {
    const r = renderValues({ ...STOCK, systemPrompt: "" });
    expect(r.ok).toBe(false);
    expect(r.output).toMatch(/systemPrompt/);
  });

  it("rejects an unknown model", () => {
    const r = renderValues({ ...STOCK, model: "gpt-9" });
    expect(r.ok).toBe(false);
    expect(r.output).toMatch(/model/);
  });

  it("rejects a team name in the wrong format", () => {
    for (const team of ["Platform", "team_platform", "-platform", "a".repeat(40)]) {
      const r = renderValues({ ...STOCK, team }, "tracer", `team-${team}`);
      expect(r.ok, team).toBe(false);
      expect(r.output, team).toMatch(/team/);
    }
  });

  it("rejects a token cap over the max", () => {
    const r = renderValues({ ...STOCK, tokenCap: 50_000_001 });
    expect(r.ok).toBe(false);
    expect(r.output).toMatch(/tokenCap/);
  });

  it("accepts a token cap at the max", () => {
    expect(renderValues({ ...STOCK, tokenCap: 50_000_000 }).ok).toBe(true);
  });

  it("rejects a missing owner", () => {
    const r = renderValues(without(STOCK, "owner"));
    expect(r.ok).toBe(false);
    expect(r.output).toMatch(/owner/);
  });
});

const CODING = { ...STOCK, runtime: "coding", description: "A coding agent" };
const SKILL_IMAGE = `172.18.0.3:5000/docs-skill@sha256:${"a".repeat(64)}`;
/** What the ApplicationSet adds to every Application: the platform's pinned skill images. */
const PLATFORM = { platform: { skillImages: { "docs-style": SKILL_IMAGE } } };

describe("agent chart: coding runtime", () => {
  it("renders a coding agent on the team base's coding Harness with git and npm egress", () => {
    const r = renderValues(CODING);
    expect(r.ok, r.output).toBe(true);
    expect(r.objects.map((o) => `${o.kind}/${o.metadata.name}`).sort()).toEqual(["Agent/tracer", "AgentTemplate/tracer", "ConfigMap/tracer-registration", "ModelConfig/tracer-model"]);
    const agent = find(r.objects, "Agent", "tracer", NS)!;
    expect(agent.spec).toEqual({
      template: { ref: { name: "tracer" } },
      harnessRef: { name: "coding" },
      egressPolicyRefs: [{ name: "git-egress" }, { name: "npm-egress" }],
    });
    expect(find(r.objects, "ConfigMap", "tracer-registration", NS)!.data.runtime).toBe("coding");
  });

  it("rejects coding with no system prompt", () => {
    const r = renderValues(without(CODING, "systemPrompt"));
    expect(r.ok).toBe(false);
    expect(r.output).toMatch(/systemPrompt/);
  });

  it("renders subagents by name as subAgent tools on the team base templates", () => {
    const r = renderValues({ ...CODING, subagents: ["explorer", "executor", "reviewer"] });
    expect(r.ok, r.output).toBe(true);
    const tools = find(r.objects, "AgentTemplate", "tracer", NS)!.spec.tools as { subAgent: { name: string; description: string; templateRef: { name: string } } }[];
    expect(tools.map((t) => [t.subAgent.name, t.subAgent.templateRef.name])).toEqual([
      ["explorer", "explorer-template"],
      ["executor", "executor-template"],
      ["reviewer", "reviewer-template"],
    ]);
    for (const t of tools) expect(t.subAgent.description, t.subAgent.name).not.toBe("");
  });

  it("renders catalog tools by name: github-read with no approval, github-write and demo-delete-branch with approval", () => {
    const r = renderValues({ ...STOCK, tools: ["github-read", "github-write", "demo-delete-branch"] });
    expect(r.ok, r.output).toBe(true);
    expect(find(r.objects, "AgentTemplate", "tracer", NS)!.spec.tools).toEqual([
      { mcp: { server: { kind: "RemoteMCPServer", name: "github-mcp" }, tools: ["issue_read"] } },
      { mcp: { server: { kind: "RemoteMCPServer", name: "github-mcp" }, tools: ["create_branch", "push_files", "create_pull_request"], requireApproval: true } },
      { mcp: { server: { kind: "RemoteMCPServer", name: "demo-mcp" }, tools: ["delete_branch"], requireApproval: true } },
    ]);
  });

  it("a read tool may ask for approval", () => {
    const r = renderValues({ ...STOCK, tools: [{ name: "github-read", requireApproval: true }] });
    expect(r.ok, r.output).toBe(true);
    expect(find(r.objects, "AgentTemplate", "tracer", NS)!.spec.tools).toEqual([
      { mcp: { server: { kind: "RemoteMCPServer", name: "github-mcp" }, tools: ["issue_read"], requireApproval: true } },
    ]);
  });

  it("a write tool gets approval forced on", () => {
    const r = renderValues({ ...STOCK, tools: [{ name: "github-write" }] });
    expect(r.ok, r.output).toBe(true);
    expect(find(r.objects, "AgentTemplate", "tracer", NS)!.spec.tools[0].mcp.requireApproval).toBe(true);
  });

  it("a write tool cannot turn approval off", () => {
    for (const name of ["github-write", "demo-delete-branch"]) {
      const r = renderValues({ ...STOCK, tools: [{ name, requireApproval: false }] });
      expect(r.ok, name).toBe(false);
      expect(r.output, name).toMatch(/requireApproval/);
    }
  });

  // The rejection must come from the catalog's name list, not from some other rule, so
  // the test reads the allowed names out of helm's schema error at the tool's path.
  it("rejects an unknown catalog tool", () => {
    const cases = [
      { tools: ["github-admin"], path: "/tools/0" },
      { tools: [{ name: "github-admin" }], path: "/tools/0/name" },
    ];
    for (const { tools, path } of cases) {
      const r = renderValues({ ...STOCK, tools });
      expect(r.ok, JSON.stringify(tools)).toBe(false);
      expect(r.output, JSON.stringify(tools)).toContain(`at '${path}': value must be one of 'github-read', 'github-write', 'demo-delete-branch'`);
    }
  });

  it("rejects an unknown subagent name", () => {
    const r = renderValues({ ...CODING, subagents: ["planner"] });
    expect(r.ok).toBe(false);
    expect(r.output).toContain("at '/subagents/0': value must be one of 'explorer', 'executor', 'reviewer'");
  });

  it("rejects an agent named like a team base subagent template", () => {
    const r = renderValues({ ...CODING, name: "explorer-template" }, "explorer-template");
    expect(r.ok).toBe(false);
    expect(r.output).toMatch(/name/);
  });

  it("renders a skill from the platform's pinned skill image", () => {
    const r = render(AGENT_CHART, "tracer", NS, [valuesFile({ ...CODING, skills: ["docs-style"] }), valuesFile(PLATFORM)]);
    expect(r.ok, r.output).toBe(true);
    expect(find(r.objects, "AgentTemplate", "tracer", NS)!.spec.skills).toEqual([{ name: "docs-style", source: { oci: SKILL_IMAGE } }]);
  });

  it("fails when a skill has no platform image yet", () => {
    const r = renderValues({ ...CODING, skills: ["docs-style"] });
    expect(r.ok).toBe(false);
    expect(r.output).toMatch(/docs-style.*make deploy/);
  });

  it("rejects an unknown skill", () => {
    const r = render(AGENT_CHART, "tracer", NS, [valuesFile({ ...CODING, skills: ["evil"] }), valuesFile(PLATFORM)]);
    expect(r.ok).toBe(false);
    expect(r.output).toMatch(/skills/);
  });
});
