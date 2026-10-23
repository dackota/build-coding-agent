import { readFileSync } from "node:fs";
import * as grpc from "@grpc/grpc-js";
import type { AgentCard } from "@a2a-js/sdk";
import { DefaultRequestHandler, InMemoryTaskStore, type TaskStore } from "@a2a-js/sdk/server";
import { A2AService, grpcService, UserBuilder } from "@a2a-js/sdk/server/grpc";
import type { EarlyListener } from "./early-listener.ts";
import { describeConfig, loadConfigFromEnv, loadRuntimeFromEnv, parseMcpBindings } from "./config.ts";
import { ControllerTaskStore, DEFAULT_IDENTITY_PATH } from "./controller-task-store.ts";
import { DEFAULT_MAX_TOOL_OUTPUT_CHARS, TRUNCATION_MARKER } from "./context.ts";
import { createExecutor, type ExecutorOptions } from "./executor.ts";
import { loadExtensions } from "./extensions.ts";
import { log } from "./log.ts";
import { fileURLToPath } from "node:url";

export type ServerOptions = { env: NodeJS.ProcessEnv; grpcAddr: string; listener: EarlyListener; cardJson?: string };

function buildCard(grpcAddr: string, cardJson?: string): AgentCard {
  const fallback: AgentCard = {
    name: "build-coding-agent",
    description: "A coding agent on kagent",
    supportedInterfaces: [{ url: grpcAddr, protocolBinding: "GRPC", tenant: "", protocolVersion: "1.0" }],
    provider: undefined,
    version: "0.1.0",
    capabilities: { streaming: true, extensions: [] },
    securitySchemes: {},
    securityRequirements: [],
    defaultInputModes: ["text/plain"],
    defaultOutputModes: ["text/plain"],
    skills: [],
    signatures: [],
  };
  if (!cardJson) return fallback;
  return { ...fallback, ...(JSON.parse(cardJson) as Partial<AgentCard>) };
}

const DEFAULT_MAX_STEPS = 25;

/** AGENT_MAX_STEPS (a positive integer, default 25), AGENT_MAX_TOOL_OUTPUT_CHARS (default 20000) and AGENT_SANDBOX ("local", the default, or "memory" for tests). */
export function executorOptions(env: NodeJS.ProcessEnv): ExecutorOptions {
  const maxSteps = env.AGENT_MAX_STEPS === undefined ? DEFAULT_MAX_STEPS : Number(env.AGENT_MAX_STEPS);
  if (!Number.isInteger(maxSteps) || maxSteps < 1) throw new Error(`AGENT_MAX_STEPS must be a positive integer, got ${JSON.stringify(env.AGENT_MAX_STEPS)}`);
  const maxToolOutputChars = env.AGENT_MAX_TOOL_OUTPUT_CHARS === undefined ? DEFAULT_MAX_TOOL_OUTPUT_CHARS : Number(env.AGENT_MAX_TOOL_OUTPUT_CHARS);
  if (!Number.isInteger(maxToolOutputChars) || maxToolOutputChars < TRUNCATION_MARKER.length + 1)
    throw new Error(`AGENT_MAX_TOOL_OUTPUT_CHARS must be an integer of at least ${TRUNCATION_MARKER.length + 1}, got ${JSON.stringify(env.AGENT_MAX_TOOL_OUTPUT_CHARS)}`);
  const sandbox = env.AGENT_SANDBOX ?? "local";
  if (sandbox !== "local" && sandbox !== "memory") throw new Error(`AGENT_SANDBOX must be "local" or "memory", got ${JSON.stringify(sandbox)}`);
  return { maxSteps, sandbox, maxToolOutputChars };
}

/** Load config, build the A2A request handler, and serve A2A over gRPC. */
export async function startServer(opts: ServerOptions): Promise<{ server: grpc.Server; shutdown(): Promise<void> }> {
  const config = loadConfigFromEnv(opts.env);
  const { controlPlaneUrl } = loadRuntimeFromEnv(opts.env);
  // kagent keeps the task record in its controller; without a control plane URL (local runs) the SDK's in-memory store does.
  const tasks: TaskStore = controlPlaneUrl
    ? new ControllerTaskStore({ controlPlaneUrl, identityPath: opts.env.KAGENT_IDENTITY_PATH ?? DEFAULT_IDENTITY_PATH })
    : new InMemoryTaskStore();
  const dataDir = opts.env.AGENT_DATA_DIR ?? "/data";
  // Key names only, never values: shows what kagent put in the config (subagent definitions included).
  const configJson = opts.env.KAGENT_CONFIG_JSON ?? readFileSync(opts.env.KAGENT_CONFIG_PATH ?? "/config/config.json", "utf8");
  const described = describeConfig(configJson);
  const mcpBindings = parseMcpBindings(configJson);
  log("config-received", {
    agentKeys: described.agentKeys.join(","),
    subAgents: JSON.stringify(described.subAgents),
    // URLs and tool names only: headers may carry credentials.
    mcp: JSON.stringify(mcpBindings.map((b) => ({ url: b.url, tools: b.tools, requireApproval: b.requireApproval }))),
  });
  const extensionsDir = opts.env.AGENT_EXTENSIONS_DIR ?? fileURLToPath(new URL("../extensions", import.meta.url));
  const extensions = await loadExtensions(extensionsDir, dataDir);
  const executor = createExecutor(config, dataDir, executorOptions(opts.env), mcpBindings, extensions);
  const handler = new DefaultRequestHandler(buildCard(opts.grpcAddr, opts.cardJson), tasks, executor);
  const server = new grpc.Server();
  server.addService(A2AService, grpcService({ requestHandler: handler, userBuilder: UserBuilder.noAuthentication }));
  const injector = server.createConnectionInjector(grpc.ServerCredentials.createInsecure());
  opts.listener.handoff((socket) => injector.injectConnection(socket));
  log("grpc-listening", { addr: opts.grpcAddr, model: config.model, taskStore: controlPlaneUrl ? "controller" : "memory" });
  return { server, shutdown: () => executor.shutdown() };
}
