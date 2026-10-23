import { readFileSync } from "node:fs";

/** A subagent kagent compiled from an AgentTemplate bound with `subAgent.templateRef`. */
export type SubAgentDef = { name: string; description: string; instruction: string; model: string; baseUrl: string };
export type AgentConfig = { model: string; baseUrl: string; instruction: string; subAgents: SubAgentDef[] };

/**
 * The slice of kagent's resolved config this agent uses: the model name, the gateway
 * base URL (with /v1), the system prompt, and the subagents under agent.sub_agents (each with
 * its own model and instruction; a missing base URL falls back to the main agent's).
 * There is no key: the gateway holds it.
 */
export function loadConfig(path: string): AgentConfig {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    throw new Error(`cannot read agent config at ${path}: ${(err as Error).message}`);
  }
  return parseConfig(text, path);
}

/** Where the config comes from: KAGENT_CONFIG_JSON (what kagent sets), else the file at KAGENT_CONFIG_PATH. */
export function loadConfigFromEnv(env: NodeJS.ProcessEnv): AgentConfig {
  if (env.KAGENT_CONFIG_JSON) return parseConfig(env.KAGENT_CONFIG_JSON, "KAGENT_CONFIG_JSON");
  return loadConfig(env.KAGENT_CONFIG_PATH ?? "/config/config.json");
}

/** Key names only, never values: safe to show in an error. */
function shape(value: unknown): string {
  if (value === null || typeof value !== "object") return typeof value;
  if (Array.isArray(value)) return `[${value.length > 0 ? shape(value[0]) : ""}]`;
  return `{${Object.entries(value).map(([k, v]) => `${k}:${shape(v)}`).join(",")}}`;
}

type ModelRaw = { model?: unknown; openai?: { base_url?: unknown } };

function parseSubAgents(raw: unknown, fallbackBaseUrl: string): SubAgentDef[] {
  if (!Array.isArray(raw)) return [];
  const defs: SubAgentDef[] = [];
  for (const [index, entry] of (raw as { name?: unknown; description?: unknown; instruction?: unknown; model?: ModelRaw }[]).entries()) {
    const model = entry?.model?.model;
    if (typeof entry?.name !== "string" || entry.name === "" || typeof model !== "string" || model === "") {
      throw new Error(`agent config: agent.sub_agents[${index}] needs a name and model.model; shape ${shape(entry)}`);
    }
    for (const key of ["http_tools", "sse_tools"] as const) {
      const tools = (entry as Record<string, unknown>)[key];
      if (Array.isArray(tools) && tools.length > 0) {
        throw new Error(`agent config: subagent ${entry.name} has ${key}; MCP tools on subagents are not supported`);
      }
    }
    const baseUrl = entry.model?.openai?.base_url;
    defs.push({
      name: entry.name,
      description: typeof entry.description === "string" ? entry.description : "",
      instruction: typeof entry.instruction === "string" ? entry.instruction : "",
      model,
      baseUrl: typeof baseUrl === "string" && baseUrl !== "" ? baseUrl : fallbackBaseUrl,
    });
  }
  return defs;
}

function parseConfig(text: string, path: string): AgentConfig {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new Error(`agent config ${path} is not JSON: ${(err as Error).message}`);
  }
  const root = (raw ?? {}) as {
    agent?: { model?: ModelRaw; instruction?: unknown; sub_agents?: unknown };
  };
  const agent = root.agent;
  const model = agent?.model?.model;
  const baseUrl = agent?.model?.openai?.base_url;
  if (typeof model !== "string" || model === "") throw new Error(`agent config ${path}: agent.model.model is missing; shape ${shape(raw)}`);
  if (typeof baseUrl !== "string" || baseUrl === "") throw new Error(`agent config ${path}: agent.model.openai.base_url is missing; shape ${shape(raw)}`);
  return {
    model,
    baseUrl,
    instruction: typeof agent?.instruction === "string" ? agent.instruction : "",
    subAgents: parseSubAgents(agent?.sub_agents, baseUrl),
  };
}

/** One MCP tool binding, as kagent resolves an AgentTemplate's `tools[].mcp` into the config. */
export type McpBinding = {
  transport: "http" | "sse";
  url: string;
  headers: Record<string, string>;
  /** The tool names the binding exposes; empty exposes every tool of the server. */
  tools: string[];
  /** Pause for a human decision before each call of a tool of this binding. */
  requireApproval: boolean;
};

type RawBinding = { params?: { url?: unknown; headers?: unknown }; tools?: unknown; require_approval?: unknown };

/** The binding's headers; a value that is not a string fails, by key name only (values may be credentials). */
function toHeaders(raw: unknown, where: string): Record<string, string> {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== "object" || Array.isArray(raw)) throw new Error(`agent config: ${where}.params.headers is not an object; shape ${shape(raw)}`);
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value !== "string") throw new Error(`agent config: ${where}.params.headers.${key} is not a string; shape ${shape(value)}`);
  }
  return { ...(raw as Record<string, string>) };
}

function toBinding(raw: RawBinding, transport: McpBinding["transport"], where: string): McpBinding {
  const url = raw?.params?.url;
  if (typeof url !== "string" || url === "") throw new Error(`agent config: ${where}.params.url is missing; shape ${shape(raw)}`);
  const headers = toHeaders(raw.params?.headers, where);
  const tools = Array.isArray(raw.tools) ? raw.tools.filter((t): t is string => typeof t === "string") : [];
  return { transport, url, headers, tools, requireApproval: raw.require_approval === true };
}

/** The MCP bindings under agent.http_tools (Streamable HTTP) and agent.sse_tools (SSE). */
export function parseMcpBindings(json: string): McpBinding[] {
  const agent = ((JSON.parse(json) as { agent?: { http_tools?: unknown; sse_tools?: unknown } }).agent ?? {}) as Record<string, unknown>;
  const list = (key: string): RawBinding[] => (Array.isArray(agent[key]) ? (agent[key] as RawBinding[]) : []);
  return [
    ...list("http_tools").map((b, i) => toBinding(b, "http", `http_tools[${i}]`)),
    ...list("sse_tools").map((b, i) => toBinding(b, "sse", `sse_tools[${i}]`)),
  ];
}

/** runtime.control_plane_url: the controller's runtime API, where Substrate injects the Actor JWT. */
export function loadRuntimeFromEnv(env: NodeJS.ProcessEnv): { controlPlaneUrl: string | undefined } {
  const text = env.KAGENT_CONFIG_JSON ?? readFileSync(env.KAGENT_CONFIG_PATH ?? "/config/config.json", "utf8");
  const url = (JSON.parse(text) as { runtime?: { control_plane_url?: unknown } }).runtime?.control_plane_url;
  return { controlPlaneUrl: typeof url === "string" && url !== "" ? url : undefined };
}

/**
 * What the config holds, by key name only (never a value): the keys under `agent`, and for
 * each subagent its name and keys. Logged at startup to show whether subagent definitions
 * reached a byo image.
 */
export function describeConfig(json: string): { agentKeys: string[]; subAgents: { name: string; keys: string[] }[] } {
  const agent = ((JSON.parse(json) as { agent?: Record<string, unknown> }).agent ?? {}) as Record<string, unknown>;
  const subs = Array.isArray(agent.sub_agents) ? (agent.sub_agents as Record<string, unknown>[]) : [];
  return {
    agentKeys: Object.keys(agent).sort(),
    subAgents: subs.map((s) => ({ name: typeof s.name === "string" ? s.name : "", keys: Object.keys(s).sort() })),
  };
}
