import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TaskState } from "@a2a-js/sdk";
import { afterEach, expect, it } from "vitest";
import { type FakeModel, type RunningAgent, type ScriptedReply, readyzStatus, sendTaskWhenUp, startAgent, startFakeModel, toolResults, waitFor, writeFakeConfig } from "./helpers.ts";

const CAP = 500;
let agent: RunningAgent | undefined;
let model: FakeModel | undefined;
afterEach(async () => {
  await agent?.stop();
  await model?.close();
  agent = model = undefined;
});

async function boot(script: ScriptedReply[]): Promise<void> {
  model = await startFakeModel(script);
  agent = await startAgent(writeFakeConfig(model.baseUrl), {
    AGENT_DATA_DIR: mkdtempSync(join(tmpdir(), "agent-data-")),
    AGENT_MAX_TOOL_OUTPUT_CHARS: String(CAP),
  });
  await waitFor(async () => (await readyzStatus(agent!.readyzPort)) === 200);
}
const call = (name: string, args: unknown): ScriptedReply => ({ toolCall: { name, args } });

it("a tool result larger than the cap reaches the model cut at the cap with a truncation marker", async () => {
  await boot([call("read_file", { path: "big.txt" }), call("search", { pattern: "line" }), "Done."]);

  const got = await sendTaskWhenUp(agent!.grpcPort, "read it", { "big.txt": "line of text\n".repeat(2000) });

  expect(got.state).toBe(TaskState.TASK_STATE_COMPLETED);
  const results = toolResults(model!);
  expect(results).toHaveLength(2);
  for (const r of results) {
    expect(r.length).toBeLessThanOrEqual(CAP);
    expect(r).toContain("[truncated");
  }
});

it("logs one token-use line per step with input, output and cached tokens", async () => {
  await boot([call("read_file", { path: "a.txt" }), "Done."]);

  await sendTaskWhenUp(agent!.grpcPort, "read it", { "a.txt": "hi\n" });

  const lines = agent!.output().split("\n").filter((l) => l.includes('"event":"step-usage"')).map((l) => JSON.parse(l));
  expect(lines).toHaveLength(2);
  expect(lines[0]).toMatchObject({ step: 1, inputTokens: 3, outputTokens: 5, cachedTokens: 2 });
  expect(lines[1]).toMatchObject({ step: 2 });
});

it("old tool results are pruned on the next turn but the latest turn is kept", async () => {
  await boot([call("read_file", { path: "a.txt" }), "Done.", "Again."]);

  const first = await sendTaskWhenUp(agent!.grpcPort, "read it", { "a.txt": "OLD-FILE-CONTENT\n" });
  await sendTaskWhenUp(agent!.grpcPort, "and now?", {}, first.contextId);

  const last = model!.requests.at(-1)!.body;
  expect(last).not.toContain("OLD-FILE-CONTENT");
  expect(last).toContain("pruned");
  expect(last).toContain("and now?");
});
