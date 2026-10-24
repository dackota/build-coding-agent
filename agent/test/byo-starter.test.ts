// The TypeScript byo starter (templates/byo-ts) as a child process, the way kagent runs a
// byo image: config from KAGENT_CONFIG_PATH, A2A over gRPC, /readyz, task store at the
// control plane.
import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";
import { startFakeController, type FakeController, SESSION_ID } from "./fake-controller.ts";
import { freePort, readyzStatus, SCRIPTED_REPLY, sendOverGrpc, startFakeModel, waitFor, writeFakeConfig, type FakeModel } from "./helpers.ts";

const STARTER_DIR = fileURLToPath(new URL("../../templates/byo-ts", import.meta.url));

type Running = { grpcPort: number; readyzPort: number; output: () => string; stop: () => Promise<void> };
let running: Running | undefined;
let controller: FakeController | undefined;
let model: FakeModel | undefined;
afterEach(async () => {
  await running?.stop();
  await controller?.close();
  await model?.close();
  running = controller = model = undefined;
});

async function startStarter(configPath: string, env: Record<string, string> = {}): Promise<Running> {
  const grpcPort = await freePort();
  const readyzPort = await freePort();
  let out = "";
  const child: ChildProcess = spawn("node", ["src/main.ts"], {
    cwd: STARTER_DIR,
    env: { PATH: process.env.PATH ?? "", KAGENT_CONFIG_PATH: configPath, KAGENT_GRPC_ADDR: `127.0.0.1:${grpcPort}`, KAGENT_READYZ_PORT: String(readyzPort), ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.on("data", (d: Buffer) => (out += d.toString()));
  child.stderr?.on("data", (d: Buffer) => (out += d.toString()));
  return {
    grpcPort,
    readyzPort,
    output: () => out,
    stop: () =>
      new Promise((resolve) => {
        if (child.exitCode !== null) return resolve();
        child.once("exit", () => resolve());
        child.kill("SIGTERM");
      }),
  };
}

const send = (port: number, text: string) =>
  waitFor(async () => {
    try {
      return await sendOverGrpc(port, text);
    } catch {
      return null;
    }
  });

it("replies over A2A gRPC with the model's text, as a task", async () => {
  model = await startFakeModel();
  running = await startStarter(writeFakeConfig(model.baseUrl));
  await waitFor(async () => (await readyzStatus(running!.readyzPort)) === 200);

  const got = await send(running.grpcPort, "What is six times seven?");

  expect(got?.reply).toBe(SCRIPTED_REPLY);
  expect(got?.kind).toBe("task");
  // The runtime config's instruction reaches the model.
  expect(model.requests[0]?.body).toContain("You are a test agent");
});

it("opens the gRPC port before /readyz answers", async () => {
  model = await startFakeModel();
  running = await startStarter(writeFakeConfig(model.baseUrl), { STARTER_TEST_HEAVY_IMPORT_DELAY_MS: "1500" });
  await waitFor(async () => (await readyzStatus(running!.readyzPort)) === 200);

  const got = await sendOverGrpc(running.grpcPort, "hello", { failFast: true });

  expect(got.reply).toBe(SCRIPTED_REPLY);
});

it("sends kagent's placeholder key to the model as a bearer token", async () => {
  model = await startFakeModel();
  running = await startStarter(writeFakeConfig(model.baseUrl), { OPENAI_API_KEY: "kagent-placeholder" });
  await waitFor(async () => (await readyzStatus(running!.readyzPort)) === 200);

  await send(running.grpcPort, "hello");

  expect(model.requests[0]?.headers.authorization).toBe("Bearer kagent-placeholder");
});

it("keeps the task at the control plane with the placeholder bearer and settles it at the real boundary", async () => {
  model = await startFakeModel();
  controller = await startFakeController();
  const identity = join(mkdtempSync(join(tmpdir(), "identity-")), "name");
  writeFileSync(identity, `session-${SESSION_ID}`);
  running = await startStarter(writeFakeConfig(model.baseUrl, { controlPlaneUrl: controller.url }), { KAGENT_IDENTITY_PATH: identity });
  await waitFor(async () => (await readyzStatus(running!.readyzPort)) === 200);

  const got = await send(running.grpcPort, "hello");

  expect(got?.reply).toBe(SCRIPTED_REPLY);
  expect(controller.calls.length).toBeGreaterThan(0);
  expect(controller.calls.every((c) => c.authorization === "Bearer placeholder")).toBe(true);
  expect(controller.calls.map((c) => c.method)).toContain("createTask");
  expect(controller.settled).toHaveLength(1);
  // Not settled before the end: the working saves came first.
  expect(controller.calls.at(-1)?.method).toBe("settleTask");
});
