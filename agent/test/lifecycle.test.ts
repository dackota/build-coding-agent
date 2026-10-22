import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { AGENT_DIR, type FakeModel, type RunningAgent, readyzStatus, sendTaskWhenUp, startAgent, startFakeModel, waitFor, writeFakeConfig } from "./helpers.ts";

let agent: RunningAgent | undefined;
let model: FakeModel | undefined;
afterEach(async () => {
  await agent?.stop();
  await model?.close();
  agent = model = undefined;
});

const events = (out: string, event: string) =>
  out
    .split("\n")
    .filter((l) => l.startsWith("{"))
    .map((l) => JSON.parse(l) as Record<string, string>)
    .filter((e) => e.event === event);

it("logs afterStart once per sandbox on its first turn, and beforeStop once when the agent is stopped", async () => {
  model = await startFakeModel();
  agent = await startAgent(writeFakeConfig(model.baseUrl), { AGENT_SANDBOX: "memory" });
  await waitFor(async () => (await readyzStatus(agent!.readyzPort)) === 200);

  const first = await sendTaskWhenUp(agent.grpcPort, "one");
  await sendTaskWhenUp(agent.grpcPort, "two", {}, first.contextId);
  expect(events(agent.output(), "afterStart")).toHaveLength(1);
  expect(events(agent.output(), "beforeStop")).toHaveLength(0);

  await sendTaskWhenUp(agent.grpcPort, "other session");
  expect(events(agent.output(), "afterStart")).toHaveLength(2);

  const running = agent;
  await running.stop();
  const stops = events(running.output(), "beforeStop");
  expect(stops.map((e) => e.contextId).sort()).toEqual(events(running.output(), "afterStart").map((e) => e.contextId).sort());
  expect(stops).toHaveLength(2);
});

it("the agent image installs git and pnpm next to node", () => {
  const dockerfile = readFileSync(join(AGENT_DIR, "Dockerfile"), "utf8");
  expect(dockerfile).toMatch(/apt-get install[^\n]*\bgit\b/);
  // -g: the actor runs commands in /data/workspaces/..., outside /app, so a project-local pin is not found there.
  expect(dockerfile).toMatch(/corepack install -g[^\n]*packageManager/);
});
