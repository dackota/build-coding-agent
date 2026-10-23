import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { describeConfig, loadConfig, loadConfigFromEnv, loadRuntimeFromEnv, parseMcpBindings, parseSkillSources } from "../src/config.ts";

function write(content: string): string {
  const path = join(mkdtempSync(join(tmpdir(), "cfg-")), "config.json");
  writeFileSync(path, content);
  return path;
}

it("reads the model name, gateway base URL, and instruction from the kagent config file", () => {
  const cfg = loadConfig(
    write(JSON.stringify({ agent: { model: { model: "glm-5", openai: { base_url: "http://gw/v1" } }, instruction: "Be brief." } })),
  );
  expect(cfg).toEqual({ model: "glm-5", baseUrl: "http://gw/v1", instruction: "Be brief.", subAgents: [] });
});

it("fails with a clear message when the model or base URL is missing", () => {
  expect(() => loadConfig(write(JSON.stringify({ agent: { model: { model: "x" } } })))).toThrow(/base_url/);
  expect(() => loadConfig(write("not json"))).toThrow(/config/i);
});

it("prefers KAGENT_CONFIG_JSON in the environment over the file path", () => {
  const json = JSON.stringify({ agent: { model: { model: "m", openai: { base_url: "http://gw/v1" } }, instruction: "i" } });
  expect(loadConfigFromEnv({ KAGENT_CONFIG_JSON: json, KAGENT_CONFIG_PATH: "/nonexistent" })).toEqual({
    model: "m",
    baseUrl: "http://gw/v1",
    instruction: "i",
    subAgents: [],
  });
});

it("never puts config values in an error, only key names", () => {
  const secret = "sk-secret-value-123";
  const bad = JSON.stringify({ agent: { model: { model: "m", openai: { api_key: secret } } } });
  try {
    loadConfigFromEnv({ KAGENT_CONFIG_JSON: bad });
    expect.unreachable();
  } catch (err) {
    expect((err as Error).message).not.toContain(secret);
    expect((err as Error).message).toContain("api_key");
  }
});

it("reports subagent names and config key names, never values", () => {
  const secret = "sk-secret-value-123";
  const json = JSON.stringify({
    agent: {
      model: { model: "m", openai: { base_url: "http://gw/v1", api_key: secret } },
      instruction: "i",
      sub_agents: [{ name: "explorer", instruction: secret, model: { model: "cheap" } }],
    },
  });
  const described = describeConfig(json);
  expect(described.subAgents).toEqual([{ name: "explorer", keys: ["instruction", "model", "name"] }]);
  expect(described.agentKeys).toEqual(["instruction", "model", "sub_agents"]);
  expect(JSON.stringify(described)).not.toContain(secret);
});

it("reads the control plane URL kagent puts under runtime", () => {
  const json = JSON.stringify({ runtime: { control_plane_url: "http://kagent-controller.kagent:8083" }, agent: {} });
  expect(loadRuntimeFromEnv({ KAGENT_CONFIG_JSON: json })).toEqual({ controlPlaneUrl: "http://kagent-controller.kagent:8083" });
  expect(loadRuntimeFromEnv({ KAGENT_CONFIG_JSON: JSON.stringify({ agent: {} }) })).toEqual({ controlPlaneUrl: undefined });
});

it("reads MCP bindings from http_tools and sse_tools with require_approval", () => {
  const json = JSON.stringify({
    agent: {
      model: { model: "m", openai: { base_url: "http://gw/v1" } },
      http_tools: [
        { params: { url: "http://mcp-a/mcp", headers: { "x-team": "a" } }, tools: ["delete_branch"], require_approval: true },
        { params: { url: "http://mcp-b/mcp" } },
      ],
      sse_tools: [{ params: { url: "http://mcp-c/sse" }, tools: [], require_approval: true }],
    },
  });
  expect(parseMcpBindings(json)).toEqual([
    { transport: "http", url: "http://mcp-a/mcp", headers: { "x-team": "a" }, tools: ["delete_branch"], requireApproval: true },
    { transport: "http", url: "http://mcp-b/mcp", headers: {}, tools: [], requireApproval: false },
    { transport: "sse", url: "http://mcp-c/sse", headers: {}, tools: [], requireApproval: true },
  ]);
  expect(parseMcpBindings(JSON.stringify({ agent: {} }))).toEqual([]);
});

it("fails on an MCP header whose value is not a string, naming the key and never the value", () => {
  const json = JSON.stringify({ agent: { http_tools: [{ params: { url: "http://mcp/mcp", headers: { authorization: { token: "sk-secret" } } } }] } });
  expect(() => parseMcpBindings(json)).toThrow(/http_tools\[0\]\.params\.headers\.authorization/);
  expect(() => parseMcpBindings(json)).not.toThrow(/sk-secret/);
});

it("fails on an MCP binding with no URL", () => {
  const json = JSON.stringify({ agent: { http_tools: [{ params: {}, require_approval: true }] } });
  expect(() => parseMcpBindings(json)).toThrow(/http_tools\[0\]\.params\.url/);
});

it("reads subagent definitions from agent.sub_agents, each with its own model and instruction", () => {
  const json = JSON.stringify({
    agent: {
      model: { model: "main", openai: { base_url: "http://gw/v1" } },
      sub_agents: [
        { name: "explorer", description: "reads", instruction: "Explore.", model: { model: "cheap" } },
        { name: "executor", description: "writes", instruction: "Execute.", model: { model: "strong", openai: { base_url: "http://other/v1" } } },
      ],
    },
  });
  expect(loadConfigFromEnv({ KAGENT_CONFIG_JSON: json }).subAgents).toEqual([
    { name: "explorer", description: "reads", instruction: "Explore.", model: "cheap", baseUrl: "http://gw/v1" },
    { name: "executor", description: "writes", instruction: "Execute.", model: "strong", baseUrl: "http://other/v1" },
  ]);
});

it("fails with the entry index and key names when a subagent has no name or model", () => {
  const secret = "sk-secret-value-456";
  const json = JSON.stringify({
    agent: { model: { model: "m", openai: { base_url: "http://gw/v1" } }, sub_agents: [{ description: secret }] },
  });
  try {
    loadConfigFromEnv({ KAGENT_CONFIG_JSON: json });
    expect.unreachable();
  } catch (err) {
    const msg = (err as Error).message;
    expect(msg).toMatch(/sub_agents\[0\]/);
    expect(msg).toContain("description");
    expect(msg).not.toContain(secret);
  }
});

describe("template skills under agent.agent_plugins", () => {
  const dirSkill = { name: "docs-style", source: { directory: "/skills/docs-style" } };
  const config = (agentPlugins: unknown) => JSON.stringify({ agent: { agent_plugins: agentPlugins } });

  it("reads a directory skill's folder", () => {
    expect(parseSkillSources(config({ skills: [dirSkill] }))).toEqual([{ name: "docs-style", dir: "/skills/docs-style" }]);
  });

  it("joins the optional path onto the folder", () => {
    const skill = { name: "x", source: { directory: "/skills/pack", path: "sub/x" } };
    expect(parseSkillSources(config({ skills: [skill] }))).toEqual([{ name: "x", dir: "/skills/pack/sub/x" }]);
  });

  it("reads the selected skills of a plugin bundle", () => {
    const plugin = { skills: ["a", "b"], source: { directory: "/plugins/p" } };
    expect(parseSkillSources(config({ plugins: [plugin] }))).toEqual([
      { name: "a", dir: "/plugins/p/skills/a" },
      { name: "b", dir: "/plugins/p/skills/b" },
    ]);
  });

  it("refuses a git skill source, naming the skill", () => {
    const skill = { name: "from-git", source: { git: { url: "https://x/y.git", commit: "abc" } } };
    expect(() => parseSkillSources(config({ skills: [skill] }))).toThrow(/from-git.*git/s);
  });

  it("refuses an S3 skill source, naming the skill", () => {
    const skill = { name: "from-s3", source: { bucket: { s3: { bucket: "b" } } } };
    expect(() => parseSkillSources(config({ skills: [skill] }))).toThrow(/from-s3.*S3/s);
  });

  it("has no skill folders without agent_plugins", () => {
    expect(parseSkillSources(JSON.stringify({ agent: { instruction: "i" } }))).toEqual([]);
    expect(parseSkillSources(config({}))).toEqual([]);
  });
});

const subWith = (extra: Record<string, unknown>) =>
  JSON.stringify({
    agent: {
      model: { model: "m", openai: { base_url: "http://gw/v1" } },
      sub_agents: [{ name: "explorer", model: { model: "cheap" }, ...extra }],
    },
  });

for (const key of ["http_tools", "sse_tools"]) {
  it(`refuses ${key} on a subagent, naming it`, () => {
    const json = subWith({ [key]: [{ params: { url: "http://mcp/x" } }] });
    expect(() => loadConfigFromEnv({ KAGENT_CONFIG_JSON: json })).toThrow(/explorer.*MCP tools on subagents are not supported/);
  });
}

it("accepts a subagent with empty or no tool lists", () => {
  for (const extra of [{}, { http_tools: [], sse_tools: [] }, { http_tools: null }]) {
    expect(loadConfigFromEnv({ KAGENT_CONFIG_JSON: subWith(extra) }).subAgents.map((s) => s.name)).toEqual(["explorer"]);
  }
});
