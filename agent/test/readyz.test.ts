import { afterEach, expect, it } from "vitest";
import { type RunningAgent, readyzStatus, startAgent, startFakeModel, waitFor, writeFakeConfig } from "./helpers.ts";

let agent: RunningAgent | undefined;
afterEach(async () => {
  await agent?.stop();
  agent = undefined;
});

it("answers /readyz 200 before the heavy modules are imported", async () => {
  const model = await startFakeModel();
  // The delay widens the window between readyz and the end of the heavy imports.
  agent = await startAgent(writeFakeConfig(model.baseUrl), { AGENT_TEST_HEAVY_IMPORT_DELAY_MS: "1500" });
  const status = await waitFor(async () => (await readyzStatus(agent!.readyzPort)) ?? false, 5000);
  const outputAtReadyz = agent.output();
  await model.close();

  expect(status).toBe(200);
  expect(outputAtReadyz).toContain("readyz-listening");
  expect(outputAtReadyz).not.toContain("heavy-imports-done");

  const done = await waitFor(async () => agent!.output().includes("heavy-imports-done"), 10000);
  expect(done).toBe(true);
});
