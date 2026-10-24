// Entrypoint. Rules 2 and 3 of docs/byo-contract.md: bind 0.0.0.0:80, and open that port
// before /readyz answers. Only node:net and node:http load before both are up; the heavy
// imports (gRPC server, A2A SDK, AI SDK) come after.
import { startEarlyListener } from "./early-listener.ts";
import { log } from "./log.ts";
import { startReadyz } from "./readyz.ts";

const READYZ_PORT = Number(process.env.KAGENT_READYZ_PORT ?? 8081);
const GRPC_ADDR = process.env.KAGENT_GRPC_ADDR ?? `0.0.0.0:${process.env.KAGENT_PORT ?? 80}`;

const listener = await startEarlyListener(GRPC_ADDR);
await startReadyz(READYZ_PORT);
log("readyz-listening", { port: READYZ_PORT });

// Test-only knob: widens the window between /readyz and a ready server.
const delayMs = Number(process.env.STARTER_TEST_HEAVY_IMPORT_DELAY_MS ?? 0);
if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));

const { startServer } = await import("./server.ts");
try {
  const { server } = await startServer({ env: process.env, listener, grpcAddr: GRPC_ADDR, cardJson: process.env.KAGENT_AGENT_CARD_JSON });
  const onSignal = () => {
    server.forceShutdown();
    process.exit(0);
  };
  process.once("SIGTERM", onSignal);
  process.once("SIGINT", onSignal);
} catch (err) {
  log("startup-failed", { message: (err as Error).message });
  process.exit(1);
}
