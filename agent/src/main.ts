// Entrypoint. /readyz must answer before anything heavy is imported: a wake is a cold
// start and Substrate's readiness probe is short. Only node:http and the logger load here.
import { startEarlyListener } from "./early-listener.ts";
import { log } from "./log.ts";
import { startReadyz } from "./readyz.ts";

const READYZ_PORT = Number(process.env.KAGENT_READYZ_PORT ?? 8081);
// kagent's contract names 127.0.0.1:80, but on alpha17 the router's dial to that address is
// refused ("tunnel failed"); all interfaces works.
const GRPC_ADDR = process.env.KAGENT_GRPC_ADDR ?? `0.0.0.0:${process.env.KAGENT_PORT ?? 80}`;

// The gRPC port opens first: once /readyz answers, Substrate resumes the actor and the
// router dials this port at once.
const listener = await startEarlyListener(GRPC_ADDR);
await startReadyz(READYZ_PORT);
log("readyz-listening", { port: READYZ_PORT });

// Test-only knob: widens the window so a test can see readyz answer first.
const delayMs = Number(process.env.AGENT_TEST_HEAVY_IMPORT_DELAY_MS ?? 0);
if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));

const { startServer } = await import("./server.ts");
log("heavy-imports-done");
try {
  const { server, shutdown } = await startServer({ env: process.env,
    listener, grpcAddr: GRPC_ADDR, cardJson: process.env.KAGENT_AGENT_CARD_JSON });
  // A stop signal (pod delete, rollout) ends each sandbox through its beforeStop hook, then the process.
  const onSignal = () => {
    void shutdown().finally(() => {
      server.forceShutdown();
      process.exit(0);
    });
  };
  process.once("SIGTERM", onSignal);
  process.once("SIGINT", onSignal);
} catch (err) {
  log("startup-failed", { message: (err as Error).message });
  process.exit(1);
}
