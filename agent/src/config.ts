import { readFileSync } from "node:fs";

export type AgentConfig = { model: string; baseUrl: string; instruction: string };

/**
 * The slice of kagent's resolved config this agent uses: the model name, the gateway
 * base URL (with /v1), and the system prompt. There is no key: the gateway holds it.
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

function parseConfig(text: string, path: string): AgentConfig {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new Error(`agent config ${path} is not JSON: ${(err as Error).message}`);
  }
  const root = (raw ?? {}) as {
    agent?: { model?: { model?: unknown; openai?: { base_url?: unknown } }; instruction?: unknown };
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
  };
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
