import { readFileSync } from "node:fs";

export type StarterConfig = {
  model: string;
  /** The gateway base URL, with /v1. */
  baseUrl: string;
  instruction: string;
  /** runtime.control_plane_url: where the task store lives; empty on a local run. */
  controlPlaneUrl: string | undefined;
};

/**
 * Rule 6 of docs/byo-contract.md: read the runtime config kagent writes. It arrives as
 * KAGENT_CONFIG_JSON, or as the file at KAGENT_CONFIG_PATH (default /config/config.json).
 * There is no model key in it: the actor holds only kagent's placeholder (see model.ts).
 */
export function loadConfig(env: NodeJS.ProcessEnv): StarterConfig {
  const text = env.KAGENT_CONFIG_JSON ?? readFileSync(env.KAGENT_CONFIG_PATH ?? "/config/config.json", "utf8");
  const root = JSON.parse(text) as {
    agent?: { model?: { model?: unknown; openai?: { base_url?: unknown } }; instruction?: unknown };
    runtime?: { control_plane_url?: unknown };
  };
  const model = root.agent?.model?.model;
  const baseUrl = root.agent?.model?.openai?.base_url;
  if (typeof model !== "string" || model === "") throw new Error("agent config: agent.model.model is missing");
  if (typeof baseUrl !== "string" || baseUrl === "") throw new Error("agent config: agent.model.openai.base_url is missing");
  const controlPlane = root.runtime?.control_plane_url;
  return {
    model,
    baseUrl,
    instruction: typeof root.agent?.instruction === "string" ? root.agent.instruction : "",
    controlPlaneUrl: typeof controlPlane === "string" && controlPlane !== "" ? controlPlane : undefined,
  };
}
