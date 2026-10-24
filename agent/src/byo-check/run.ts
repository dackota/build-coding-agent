// The contract check: play kagent's side against a running image and judge each rule.
// Runs in a pod next to the image (see platform/byo-check.sh), or in a test against a process.
import { lookup } from "node:dns/promises";
import { connect } from "node:net";
import * as grpc from "@grpc/grpc-js";
import { Role } from "@a2a-js/sdk";
import { ClientFactory, ClientFactoryOptions } from "@a2a-js/sdk/client";
import { GrpcTransportFactory } from "@a2a-js/sdk/client/grpc";
import { evaluate, formatReport, type Observations, type RuleResult, type SendOutcome } from "./rules.ts";
import { SCRIPTED_REPLY, startControllerStub, startModelStub } from "./stubs.ts";

const POLL_MS = 20;
const PROBE_TIMEOUT_MS = 500;
const SEND_TIMEOUT_MS = 60_000;
const SETTLE_GRACE_MS = 3_000;
const TASK_STATE_COMPLETED = 3;
const USER_TEXT = "What is six times seven?";

export type CheckOptions = {
  /** The image's address: a pod IP or a DNS name that resolves once the pod has an IP. */
  agentHost: string;
  grpcPort: number;
  readyzPort: number;
  controllerPort: number;
  modelPort: number;
  /** The address the stand-ins listen on. */
  stubHost: string;
  /** The session in the image's /run/kagent/identity/name. */
  sessionId: string;
  /** What OPENAI_API_KEY holds in the image: the placeholder the model route should see. */
  apiKey: string;
  /** agent.instruction in the image's config. */
  instruction: string;
  readyTimeoutMs: number;
  /** How long to wait for the gRPC port after /readyz answered before calling it never open. */
  lateGrpcWaitMs: number;
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function portOpen(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host, port, timeout: PROBE_TIMEOUT_MS });
    socket.once("connect", () => (socket.destroy(), resolve(true)));
    socket.once("timeout", () => (socket.destroy(), resolve(false)));
    socket.once("error", () => resolve(false));
  });
}

async function readyzAnswers(host: string, port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://${host}:${port}/readyz`, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
    return res.status === 200;
  } catch {
    return false;
  }
}

async function resolveHost(host: string, timeoutMs: number): Promise<string | undefined> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      return (await lookup(host, { family: 4 })).address;
    } catch {
      await sleep(POLL_MS);
    }
  }
  return undefined;
}

/** Poll /readyz; the moment it answers, probe the gRPC port (rules 2 and 3). */
async function watchStartup(host: string, o: CheckOptions): Promise<Pick<Observations, "readyz" | "grpcOpenAtReadyz">> {
  const deadline = Date.now() + o.readyTimeoutMs;
  while (Date.now() < deadline) {
    if (await readyzAnswers(host, o.readyzPort)) {
      if (await portOpen(host, o.grpcPort)) return { readyz: "answered", grpcOpenAtReadyz: true };
      const lateDeadline = Date.now() + o.lateGrpcWaitMs;
      while (Date.now() < lateDeadline) {
        await sleep(POLL_MS);
        if (await portOpen(host, o.grpcPort)) return { readyz: "answered", grpcOpenAtReadyz: "late" };
      }
      return { readyz: "answered", grpcOpenAtReadyz: "never" };
    }
    await sleep(POLL_MS);
  }
  return { readyz: "never", grpcOpenAtReadyz: undefined };
}

async function sendOneMessage(host: string, port: number): Promise<SendOutcome> {
  const factory = new ClientFactory(
    ClientFactoryOptions.createFrom(ClientFactoryOptions.default, {
      transports: [new GrpcTransportFactory({ grpcChannelCredentials: grpc.credentials.createInsecure() })],
    }),
  );
  const call = async (): Promise<SendOutcome> => {
    const client = await factory.createFromAgentCard({
      name: "byo-check",
      description: "",
      supportedInterfaces: [{ url: `${host}:${port}`, protocolBinding: "GRPC", tenant: "", protocolVersion: "1.0" }],
      provider: undefined,
      version: "0",
      capabilities: { streaming: true, extensions: [] },
      securitySchemes: {},
      securityRequirements: [],
      defaultInputModes: ["text/plain"],
      defaultOutputModes: ["text/plain"],
      skills: [],
      signatures: [],
    });
    const result = await client.sendMessage({
      tenant: "",
      message: {
        messageId: "byo-check-1",
        contextId: "",
        taskId: "",
        role: Role.ROLE_USER,
        parts: [{ content: { $case: "text", value: USER_TEXT }, metadata: undefined, filename: "", mediaType: "" }],
        metadata: undefined,
        extensions: [],
        referenceTaskIds: [],
      },
      configuration: undefined,
      metadata: undefined,
    });
    const isTask = "status" in result;
    const parts = "artifacts" in result ? result.artifacts.flatMap((a) => a.parts) : result.parts;
    const reply = parts.map((p) => (p.content?.$case === "text" ? p.content.value : "")).join("");
    return { ok: true, kind: isTask ? "task" : "message", completed: isTask && result.status?.state === TASK_STATE_COMPLETED, reply };
  };
  try {
    return await Promise.race([call(), sleep(SEND_TIMEOUT_MS).then((): SendOutcome => ({ ok: false, error: `no reply within ${SEND_TIMEOUT_MS / 1000}s` }))]);
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

/** Run every check against the image and return one result per rule. */
export async function runChecks(o: CheckOptions): Promise<RuleResult[]> {
  const controller = await startControllerStub(o.stubHost, o.controllerPort, o.sessionId);
  const model = await startModelStub(o.stubHost, o.modelPort);
  try {
    const host = await resolveHost(o.agentHost, o.readyTimeoutMs);
    const startup = host ? await watchStartup(host, o) : ({ readyz: "never", grpcOpenAtReadyz: undefined } as const);
    const send = host && startup.grpcOpenAtReadyz !== undefined && startup.grpcOpenAtReadyz !== "never" ? await sendOneMessage(host, o.grpcPort) : undefined;
    const graceEnds = Date.now() + SETTLE_GRACE_MS;
    while (send && controller.calls.every((c) => c.method !== "settleTask") && Date.now() < graceEnds) await sleep(POLL_MS);
    return evaluate({
      ...startup,
      send,
      expectedReply: SCRIPTED_REPLY,
      controllerCalls: [...controller.calls],
      refusedSettles: controller.refusedSettles(),
      modelRequests: [...model.requests],
      sessionId: o.sessionId,
      apiKey: o.apiKey,
      instruction: o.instruction,
    });
  } finally {
    await Promise.all([controller.close(), model.close()]);
  }
}

function envOr(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (v === undefined || v === "") throw new Error(`byo-check: ${name} is not set`);
  return v;
}

/** The pod entry: options from env, the report on stdout, exit 1 when any rule failed. */
export async function main(): Promise<void> {
  const results = await runChecks({
    agentHost: envOr("BYO_AGENT_HOST"),
    grpcPort: Number(envOr("BYO_GRPC_PORT", "80")),
    readyzPort: Number(envOr("BYO_READYZ_PORT", "8081")),
    controllerPort: Number(envOr("BYO_CONTROLLER_PORT", "9090")),
    modelPort: Number(envOr("BYO_MODEL_PORT", "9091")),
    stubHost: "0.0.0.0",
    sessionId: envOr("BYO_SESSION_ID"),
    apiKey: envOr("BYO_API_KEY", "kagent-placeholder"),
    instruction: envOr("BYO_INSTRUCTION"),
    readyTimeoutMs: Number(envOr("BYO_READY_TIMEOUT_MS", "180000")),
    lateGrpcWaitMs: Number(envOr("BYO_LATE_GRPC_WAIT_MS", "5000")),
  });
  process.stdout.write(formatReport(results));
  process.exit(results.some((r) => r.status === "fail") ? 1 : 0);
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main().catch((err: Error) => {
    process.stderr.write(`byo-check: ${err.message}\n`);
    process.exit(2);
  });
}
