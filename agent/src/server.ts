import * as grpc from "@grpc/grpc-js";
import type { AgentCard } from "@a2a-js/sdk";
import { DefaultRequestHandler, InMemoryTaskStore } from "@a2a-js/sdk/server";
import { A2AService, grpcService, UserBuilder } from "@a2a-js/sdk/server/grpc";
import type { EarlyListener } from "./early-listener.ts";
import { loadConfigFromEnv } from "./config.ts";
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
  const handler = new DefaultRequestHandler(buildCard(opts.grpcAddr, opts.cardJson), new InMemoryTaskStore(), createExecutor(config));
  const server = new grpc.Server();
  server.addService(A2AService, grpcService({ requestHandler: handler, userBuilder: UserBuilder.noAuthentication }));
  const injector = server.createConnectionInjector(grpc.ServerCredentials.createInsecure());
  opts.listener.handoff((socket) => injector.injectConnection(socket));
  log("grpc-listening", { addr: opts.grpcAddr, model: config.model });
  return server;
}
