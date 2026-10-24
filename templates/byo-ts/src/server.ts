import * as grpc from "@grpc/grpc-js";
import type { AgentCard } from "@a2a-js/sdk";
import { DefaultRequestHandler, InMemoryTaskStore, type TaskStore } from "@a2a-js/sdk/server";
import { A2AService, grpcService, UserBuilder } from "@a2a-js/sdk/server/grpc";
import type { EarlyListener } from "./early-listener.ts";
import { loadConfig } from "./config.ts";
import { createExecutor } from "./executor.ts";
import { log } from "./log.ts";
import { ControllerTaskStore, DEFAULT_IDENTITY_PATH } from "./task-store.ts";

export type ServerOptions = { env: NodeJS.ProcessEnv; grpcAddr: string; listener: EarlyListener; cardJson?: string };

/** The agent card kagent passes in KAGENT_AGENT_CARD_JSON, over a fallback for local runs. */
function buildCard(grpcAddr: string, cardJson?: string): AgentCard {
  const fallback: AgentCard = {
    name: "byo-ts-starter",
    description: "A minimal byo agent",
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
  return cardJson ? { ...fallback, ...(JSON.parse(cardJson) as Partial<AgentCard>) } : fallback;
}

/** Load the runtime config, build the A2A handler on the controller's task store, and serve gRPC on the early listener. */
export async function startServer(opts: ServerOptions): Promise<{ server: grpc.Server }> {
  const config = loadConfig(opts.env);
  // Rule 4: the task record lives in kagent's controller; without a control plane URL (a local run) it is in memory.
  const tasks: TaskStore = config.controlPlaneUrl
    ? new ControllerTaskStore({ controlPlaneUrl: config.controlPlaneUrl, identityPath: opts.env.KAGENT_IDENTITY_PATH ?? DEFAULT_IDENTITY_PATH })
    : new InMemoryTaskStore();
  const handler = new DefaultRequestHandler(buildCard(opts.grpcAddr, opts.cardJson), tasks, createExecutor(config, opts.env));
  const server = new grpc.Server();
  server.addService(A2AService, grpcService({ requestHandler: handler, userBuilder: UserBuilder.noAuthentication }));
  const injector = server.createConnectionInjector(grpc.ServerCredentials.createInsecure());
  opts.listener.handoff((socket) => injector.injectConnection(socket));
  log("grpc-listening", { addr: opts.grpcAddr, model: config.model, taskStore: config.controlPlaneUrl ? "controller" : "memory" });
  return { server };
}
