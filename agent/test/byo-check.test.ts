// make byo-check's checker: it plays kagent's side of the byo contract (the task store, the
// model route, the config) against a running image and reports pass or fail per rule.
import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { networkInterfaces, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { evaluate, formatReport, type Observations } from "../src/byo-check/rules.ts";
import { runChecks } from "../src/byo-check/run.ts";
import { freePort } from "./helpers.ts";

const STARTER_DIR = fileURLToPath(new URL("../../templates/byo-ts", import.meta.url));
const LATE_PORT_AGENT = fileURLToPath(new URL("./fixtures/byo-late-port/main.mjs", import.meta.url));
const SESSION_ID = "11111111-2222-4333-8444-555555555555";
const API_KEY = "kagent-placeholder";
const INSTRUCTION = "You are the contract check's agent.";

/** The first non-loopback IPv4 address: what a pod IP is to the checker (a loopback bind refuses it). */
const lanAddress = Object.values(networkInterfaces())
  .flat()
  .find((i) => i && i.family === "IPv4" && !i.internal)?.address;

let child: ChildProcess | undefined;
afterEach(() => {
  child?.kill("SIGTERM");
  child = undefined;
});

type Ports = { grpc: number; readyz: number; controller: number; model: number };

async function ports(): Promise<Ports> {
  return { grpc: await freePort(), readyz: await freePort(), controller: await freePort(), model: await freePort() };
}

function writeConfig(p: Ports): { config: string; identity: string } {
  const dir = mkdtempSync(join(tmpdir(), "byo-check-"));
  const config = join(dir, "config.json");
  writeFileSync(
    config,
    JSON.stringify({
      runtime: { control_plane_url: `http://127.0.0.1:${p.controller}` },
      agent: { model: { model: "check-model", openai: { base_url: `http://127.0.0.1:${p.model}/v1` } }, instruction: INSTRUCTION },
    }),
  );
  const identity = join(dir, "name");
  writeFileSync(identity, `session-${SESSION_ID}`);
  return { config, identity };
}

function startStarter(p: Ports, bindHost: string): void {
  const { config, identity } = writeConfig(p);
  child = spawn("node", ["src/main.ts"], {
    cwd: STARTER_DIR,
    env: {
      PATH: process.env.PATH ?? "",
      KAGENT_CONFIG_PATH: config,
      KAGENT_IDENTITY_PATH: identity,
      KAGENT_GRPC_ADDR: `${bindHost}:${p.grpc}`,
      KAGENT_READYZ_PORT: String(p.readyz),
      OPENAI_API_KEY: API_KEY,
    },
    stdio: "ignore",
  });
}

const checkOptions = (p: Ports) => ({
  agentHost: lanAddress ?? "127.0.0.1",
  grpcPort: p.grpc,
  readyzPort: p.readyz,
  controllerPort: p.controller,
  modelPort: p.model,
  stubHost: "0.0.0.0",
  sessionId: SESSION_ID,
  apiKey: API_KEY,
  instruction: INSTRUCTION,
  readyTimeoutMs: 20_000,
  lateGrpcWaitMs: 4_000,
});

const byRule = (results: { rule: number; status: string }[]) => Object.fromEntries(results.map((r) => [r.rule, r.status]));

describe.skipIf(!lanAddress)("runChecks against a running image", () => {
  it("passes every checkable rule for the starter", async () => {
    const p = await ports();
    startStarter(p, "0.0.0.0");

    const results = await runChecks(checkOptions(p));

    expect(byRule(results)).toEqual({ 1: "pass", 2: "pass", 3: "pass", 4: "pass", 5: "pass", 6: "pass", 7: "skip", 8: "skip", 9: "skip" });
  }, 60_000);

  it("fails the bind rule, and only it, for an image that binds loopback", async () => {
    const p = await ports();
    startStarter(p, "127.0.0.1");

    const results = await runChecks(checkOptions(p));
    const failed = results.filter((r) => r.status === "fail");

    expect(failed.map((r) => r.rule)).toEqual([2]);
    expect(failed[0]?.detail).toMatch(/0\.0\.0\.0/);
    expect(formatReport(results)).toMatch(/FAIL\s+2\b.*bind/i);
  }, 60_000);

  it("fails the early-port rule for an image whose /readyz answers before the gRPC port opens", async () => {
    const p = await ports();
    child = spawn("node", [LATE_PORT_AGENT], {
      env: { PATH: process.env.PATH ?? "", KAGENT_PORT: String(p.grpc), KAGENT_READYZ_PORT: String(p.readyz) },
      stdio: "ignore",
    });

    const results = await runChecks(checkOptions(p));

    expect(byRule(results)[3]).toBe("fail");
    expect(results.find((r) => r.rule === 3)?.detail).toMatch(/readyz/i);
  }, 60_000);
});

const GOOD: Observations = {
  readyz: "answered",
  grpcOpenAtReadyz: true,
  send: { ok: true, kind: "task", completed: true, reply: "the scripted reply" },
  expectedReply: "the scripted reply",
  controllerCalls: [
    { method: "createTask", authorization: "Bearer placeholder", sessionId: SESSION_ID },
    { method: "updateTask", authorization: "Bearer placeholder", sessionId: SESSION_ID },
    { method: "settleTask", authorization: "Bearer placeholder", sessionId: SESSION_ID },
  ],
  refusedSettles: 0,
  modelRequests: [{ path: "/v1/chat/completions", authorization: `Bearer ${API_KEY}`, body: JSON.stringify({ messages: [{ role: "system", content: INSTRUCTION }] }) }],
  sessionId: SESSION_ID,
  apiKey: API_KEY,
  instruction: INSTRUCTION,
};

const statusOf = (obs: Observations, rule: number) => evaluate(obs).find((r) => r.rule === rule);

describe("evaluate", () => {
  it("passes rules 1 to 6 on good observations and skips 7 to 9 with a reason", () => {
    const results = evaluate(GOOD);
    expect(byRule(results)).toEqual({ 1: "pass", 2: "pass", 3: "pass", 4: "pass", 5: "pass", 6: "pass", 7: "skip", 8: "skip", 9: "skip" });
    expect(results.find((r) => r.rule === 7)?.detail).toMatch(/not checked/i);
  });

  it("fails rule 1 when the reply is a bare message and not a task", () => {
    expect(statusOf({ ...GOOD, send: { ok: true, kind: "message", completed: false, reply: "x" } }, 1)?.status).toBe("fail");
  });

  it("fails rule 1 and names the error when the gRPC call fails", () => {
    const r = statusOf({ ...GOOD, send: { ok: false, error: "14 UNAVAILABLE" } }, 1);
    expect(r?.status).toBe("fail");
    expect(r?.detail).toContain("14 UNAVAILABLE");
  });

  it("fails rule 2 when the gRPC port refused the pod address", () => {
    expect(statusOf({ ...GOOD, grpcOpenAtReadyz: "never" }, 2)?.status).toBe("fail");
  });

  it("fails rule 3 when the port opened only after /readyz", () => {
    expect(statusOf({ ...GOOD, grpcOpenAtReadyz: "late" }, 3)?.status).toBe("fail");
  });

  it("fails rule 3 when /readyz never answered", () => {
    expect(statusOf({ ...GOOD, readyz: "never", grpcOpenAtReadyz: undefined }, 3)?.status).toBe("fail");
  });

  it("fails rule 4 when a task store call carries another bearer", () => {
    const calls = GOOD.controllerCalls.map((c, i) => (i === 1 ? { ...c, authorization: "Bearer real-jwt" } : c));
    const r = statusOf({ ...GOOD, controllerCalls: calls }, 4);
    expect(r?.status).toBe("fail");
    expect(r?.detail).toContain("Bearer placeholder");
  });

  it("fails rule 4 when the image never called the task store", () => {
    expect(statusOf({ ...GOOD, controllerCalls: [] }, 4)?.status).toBe("fail");
  });

  it("fails rule 4 when the session id is not the one in the identity file", () => {
    const calls = GOOD.controllerCalls.map((c) => ({ ...c, sessionId: "00000000-0000-4000-8000-000000000000" }));
    expect(statusOf({ ...GOOD, controllerCalls: calls }, 4)?.status).toBe("fail");
  });

  it("fails rule 5 when the task was never settled", () => {
    expect(statusOf({ ...GOOD, controllerCalls: GOOD.controllerCalls.slice(0, 2) }, 5)?.status).toBe("fail");
  });

  it("fails rule 5 when a settle was refused or repeated", () => {
    expect(statusOf({ ...GOOD, refusedSettles: 1 }, 5)?.status).toBe("fail");
    expect(statusOf({ ...GOOD, controllerCalls: [...GOOD.controllerCalls, GOOD.controllerCalls[2]!] }, 5)?.status).toBe("fail");
  });

  it("fails rule 6 when the model call lacks the placeholder key or the instruction", () => {
    const noKey = [{ ...GOOD.modelRequests[0]!, authorization: undefined }];
    const noPrompt = [{ ...GOOD.modelRequests[0]!, body: "{}" }];
    expect(statusOf({ ...GOOD, modelRequests: noKey }, 6)?.status).toBe("fail");
    expect(statusOf({ ...GOOD, modelRequests: noPrompt }, 6)?.status).toBe("fail");
    expect(statusOf({ ...GOOD, modelRequests: [] }, 6)?.status).toBe("fail");
  });
});

describe("formatReport", () => {
  it("prints one PASS, FAIL or skip line per rule with its name, and a verdict", () => {
    const text = formatReport(evaluate({ ...GOOD, grpcOpenAtReadyz: "never" }));
    expect(text.split("\n").filter((l) => /^(PASS|FAIL|skip)\s/.test(l))).toHaveLength(9);
    expect(text).toMatch(/FAIL\s+2\b.*bind/i);
    expect(text).toMatch(/byo-check: FAILED/);
  });

  it("says PASSED when no rule failed", () => {
    expect(formatReport(evaluate(GOOD))).toMatch(/byo-check: PASSED/);
  });
});
