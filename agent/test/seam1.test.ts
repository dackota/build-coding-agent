import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import {
  AGENT_DIR,
  KEY_SENTINEL,
  type RunningAgent,
  SCRIPTED_REPLY,
  readyzStatus,
  sendOverGrpc,
  startAgent,
  startFakeModel,
  waitFor,
  writeFakeConfig,
} from "./helpers.ts";

let agent: RunningAgent | undefined;
afterEach(async () => {
  await agent?.stop();
  agent = undefined;
});

it("replies with the scripted model's text over A2A gRPC", async () => {
  const model = await startFakeModel();
  agent = await startAgent(writeFakeConfig(model.baseUrl));
  await waitFor(async () => (await readyzStatus(agent!.readyzPort)) === 200);

  const got = await waitFor(async () => {
    try {
      return await sendOverGrpc(agent!.grpcPort, "What is six times seven?");
    } catch {
      return null;
    }
  });
  await model.close();

  expect(got?.reply).toBe(SCRIPTED_REPLY);
  // A task, so kagent's controller keeps a record of it and HITL pauses are possible.
  expect(got?.kind).toBe("task");
  expect(got?.contextId).toBeTruthy();
});

it("never sends, logs, or stores a model key", async () => {
  const model = await startFakeModel();
  const configPath = writeFakeConfig(model.baseUrl);
  // A key in the agent's environment must still never reach the model call or the logs.
  agent = await startAgent(configPath, { OPENCODE_KEY: KEY_SENTINEL });
  await waitFor(async () => (await readyzStatus(agent!.readyzPort)) === 200);
  const got = await waitFor(async () => {
    try {
      return await sendOverGrpc(agent!.grpcPort, "hello");
    } catch {
      return null;
    }
  });
  await model.close();

  expect(got?.reply).toBe(SCRIPTED_REPLY);
  expect(model.requests.length).toBeGreaterThan(0);
  for (const r of model.requests) {
    expect(r.headers.authorization).toBeUndefined();
    expect(JSON.stringify(r)).not.toContain(KEY_SENTINEL);
  }
  expect(agent.output()).not.toContain(KEY_SENTINEL);
  expect(readFileSync(configPath, "utf8")).not.toContain(KEY_SENTINEL);
  const template = readFileSync(join(AGENT_DIR, "..", "platform", "agent.yaml.tmpl"), "utf8");
  expect(template).not.toMatch(/OPENCODE_KEY|apiKey|api_key/i);
});

it("accepts a gRPC connection as soon as /readyz answers, and replies once the heavy imports finish", async () => {
  // Substrate restores the actor when /readyz answers, then the router dials the gRPC port
  // at once. A refused connection there fails the user's message, so the port must be open
  // before the heavy imports finish.
  const model = await startFakeModel();
  agent = await startAgent(writeFakeConfig(model.baseUrl), { AGENT_TEST_HEAVY_IMPORT_DELAY_MS: "1500" });
  await waitFor(async () => (await readyzStatus(agent!.readyzPort)) === 200);

  let reply: string | undefined;
  try {
    reply = (await sendOverGrpc(agent!.grpcPort, "hello", { failFast: true })).reply;
  } catch {
    reply = undefined;
  }
  await model.close();

  expect(reply).toBe(SCRIPTED_REPLY);
});
