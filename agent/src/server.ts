import { readFileSync } from "node:fs";
import * as grpc from "@grpc/grpc-js";
import type { AgentCard } from "@a2a-js/sdk";
import { DefaultRequestHandler, InMemoryTaskStore, type TaskStore } from "@a2a-js/sdk/server";
import { A2AService, grpcService, UserBuilder } from "@a2a-js/sdk/server/grpc";
import type { EarlyListener } from "./early-listener.ts";
import { describeConfig, loadConfigFromEnv, loadRuntimeFromEnv } from "./config.ts";
import { ControllerTaskStore, DEFAULT_IDENTITY_PATH } from "./controller-task-store.ts";
import { createExecutor } from "./executor.ts";
import { log } from "./log.ts";

export type ServerOptions = { env: NodeJS.ProcessEnv; grpcAddr: string; listener: EarlyListener; cardJson?: string };

function buildCard(grpcAddr: string, cardJson?: string): AgentCard {
  const fallback: AgentCard = {
    name: "build-coding-agent",
    description: "A coding agent on kagent",
    supportedInterfaces: [{ url: grpcAddr, protocolBinding: "GRPC", tenant: "", protocolVersion: "1.0" }],
    provider: undefined,
    version: "0.1.0",
    capabilities: { streaming: false, extensions: [] },
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

/** Load config, build the A2A request handler, and serve A2A over gRPC. */
export async function startServer(opts: ServerOptions): Promise<grpc.Server> {
  const config = loadConfigFromEnv(opts.env);
  const { controlPlaneUrl } = loadRuntimeFromEnv(opts.env);
  // kagent keeps the task record in its controller; without a control plane URL (local runs) the SDK's in-memory store does.
  const tasks: TaskStore = controlPlaneUrl
    ? new ControllerTaskStore({ controlPlaneUrl, identityPath: opts.env.KAGENT_IDENTITY_PATH ?? DEFAULT_IDENTITY_PATH })
    : new InMemoryTaskStore();
  const dataDir = opts.env.AGENT_DATA_DIR ?? "/data";
  // Key names only, never values: shows what kagent put in the config (subagent definitions included).
  const described = describeConfig(opts.env.KAGENT_CONFIG_JSON ?? readFileSync(opts.env.KAGENT_CONFIG_PATH ?? "/config/config.json", "utf8"));
  log("config-received", { agentKeys: described.agentKeys.join(","), subAgents: JSON.stringify(described.subAgents) });
  const handler = new DefaultRequestHandler(buildCard(opts.grpcAddr, opts.cardJson), tasks, createExecutor(config, dataDir));
  const server = new grpc.Server();
  server.addService(A2AService, grpcService({ requestHandler: handler, userBuilder: UserBuilder.noAuthentication }));
  const injector = server.createConnectionInjector(grpc.ServerCredentials.createInsecure());
  opts.listener.handoff((socket) => injector.injectConnection(socket));
  log("grpc-listening", { addr: opts.grpcAddr, model: config.model, taskStore: controlPlaneUrl ? "controller" : "memory" });
  return server;
}
