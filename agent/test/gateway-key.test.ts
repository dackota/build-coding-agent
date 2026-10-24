// The keyed model route: the coding agent sends kagent's placeholder key (OPENAI_API_KEY in
// the actor's env) as a Bearer token, which Substrate's egress gateway swaps for the agent's
// own key. Without the variable it sends no Authorization at all (seam1.test.ts).
import { afterEach, expect, it } from "vitest";
import { type RunningAgent, readyzStatus, sendOverGrpc, startAgent, startFakeModel, waitFor, writeFakeConfig } from "./helpers.ts";

const PLACEHOLDER = "kagent-credential-injected";

let agent: RunningAgent | undefined;
afterEach(async () => {
  await agent?.stop();
  agent = undefined;
});

it("sends the placeholder key from OPENAI_API_KEY as a Bearer token", async () => {
  const model = await startFakeModel();
  agent = await startAgent(writeFakeConfig(model.baseUrl), { OPENAI_API_KEY: PLACEHOLDER });
  await waitFor(async () => (await readyzStatus(agent!.readyzPort)) === 200);
  await waitFor(async () => {
    try {
      return await sendOverGrpc(agent!.grpcPort, "hello");
    } catch {
      return null;
    }
  });
  await model.close();

  expect(model.requests.length).toBeGreaterThan(0);
  for (const r of model.requests) expect(r.headers.authorization).toBe(`Bearer ${PLACEHOLDER}`);
});
