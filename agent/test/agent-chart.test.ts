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
    expect(r.objects.map((o) => `${o.kind}/${o.metadata.name}`).sort()).toEqual(["Agent/tracer", "AgentTemplate/tracer", "ConfigMap/tracer-registration"]);

    const template = find(r.objects, "AgentTemplate", "tracer", NS)!;
    expect(template.apiVersion).toBe("api.kagent.dev/v1alpha3");
    expect(template.spec).toEqual({
      description: "A stock agent that answers briefly",
      modelConfig: { name: "default-model-config" },
      systemPrompt: "You are a concise, helpful assistant. Reply briefly.",
    });

    const agent = find(r.objects, "Agent", "tracer", NS)!;
    expect(agent.apiVersion).toBe("api.kagent.dev/v1alpha3");
    expect(agent.spec).toEqual({ template: { ref: { name: "tracer" } }, harnessRef: { name: "kagent-stock" } });

    const registration = find(r.objects, "ConfigMap", "tracer-registration", NS)!;
    expect(registration.metadata.labels?.["agents.build-coding-agent.dev/registration"]).toBe("true");
    expect(registration.data).toEqual({ team: "platform", agent: "tracer", owner: "dackota", runtime: "stock", model: "glm-5.3-flash", tokenCap: "1000000" });
  });

  it("rejects a runtime outside the enum", () => {
    const r = renderValues({ ...STOCK, runtime: "python" });
    expect(r.ok).toBe(false);
    expect(r.output).toMatch(/runtime/);
  });

  it("refuses to render coding and byo in this release", () => {
    for (const runtime of ["coding", "byo"]) {
      const r = renderValues({ ...STOCK, runtime });
      expect(r.ok, runtime).toBe(false);
      expect(r.output).toMatch(new RegExp(`runtime ${runtime} is not supported yet`));
    }
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
