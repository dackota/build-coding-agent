import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import fc from "fast-check";
import { afterEach, expect, it } from "vitest";
import { type FakeModel, type RunningAgent, type ScriptedReply, readyzStatus, sendTaskWhenUp, startAgent, startFakeModel, toolResults, waitFor, writeFakeConfig } from "./helpers.ts";

let agent: RunningAgent | undefined;
let model: FakeModel | undefined;
afterEach(async () => {
  await agent?.stop();
  await model?.close();
  agent = model = undefined;
});

const PLAN_DIR = fileURLToPath(new URL("./fixtures/extensions-plan", import.meta.url));
const PLANS = 50;
const SEED = 2410;
const ORIG = "orig";

const action = fc.oneof(
  fc.constant("pass"),
  fc.constant("throw"),
  fc.stringMatching(/^[a-z0-9]{1,8}$/).map((w) => `block-${w}`),
);
const plans = fc.sample(fc.tuple(action, action, action), { numRuns: PLANS, seed: SEED });
const pathOf = (i: number, plan: readonly string[]) => `p${i}--${plan.join("--")}.txt`;

it("the first handler that does not pass decides, for 50 generated plans", { timeout: 180_000 }, async () => {
  const script: ScriptedReply[] = plans.flatMap((plan, i) => [{ toolCall: { name: "write_file", args: { path: pathOf(i, plan), content: ORIG } } }, "ok"]);
  model = await startFakeModel(script);
  const dataDir = mkdtempSync(join(tmpdir(), "agent-data-"));
  agent = await startAgent(writeFakeConfig(model.baseUrl), { AGENT_DATA_DIR: dataDir, AGENT_EXTENSIONS_DIR: PLAN_DIR });
  await waitFor(async () => (await readyzStatus(agent!.readyzPort)) === 200);

  for (const [i, plan] of plans.entries()) {
    const contextId = `ctx-plan-${i}`;
    await sendTaskWhenUp(agent.grpcPort, `plan ${i}`, {}, contextId);
    const result = toolResults(model).join("\n");
    const file = join(dataDir, "workspaces", contextId, pathOf(i, plan));
    const k = plan.findIndex((a) => a !== "pass");
    const decider = plan[k];
    if (decider === undefined) {
      expect(existsSync(file), `plan ${i} ${plan.join(",")}`).toBe(true);
      expect(readFileSync(file, "utf8")).toBe(ORIG);
    } else if (decider === "throw") {
      expect(result, `plan ${i} ${plan.join(",")}`).toContain(`extension h${k + 1} failed on tool_call`);
      expect(existsSync(file)).toBe(false);
    } else {
      expect(result, `plan ${i} ${plan.join(",")}`).toBe(`blocked by h${k + 1}: ${decider.slice("block-".length)}`);
      expect(existsSync(file)).toBe(false);
    }
  }
});
