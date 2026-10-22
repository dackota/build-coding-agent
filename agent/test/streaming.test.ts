import { TaskState } from "@a2a-js/sdk";
import { afterEach, expect, it } from "vitest";
import { type FakeModel, readyzStatus, type RunningAgent, startAgent, startFakeModel, streamMessage, waitFor, writeFakeConfig } from "./helpers.ts";

let agent: RunningAgent | undefined;
let model: FakeModel | undefined;
afterEach(async () => {
  await agent?.stop();
  await model?.close();
  agent = model = undefined;
});

async function boot(script: Parameters<typeof startFakeModel>[0]): Promise<RunningAgent> {
  model = await startFakeModel(script);
  agent = await startAgent(writeFakeConfig(model.baseUrl), { AGENT_SANDBOX: "memory" });
  await waitFor(async () => (await readyzStatus(agent!.readyzPort)) === 200);
  return agent;
}

it("streams tool calls and text before the final reply", async () => {
  const running = await boot([{ toolCall: { name: "list_files", args: {} } }, "All done here."]);

  const events = await waitFor(async () => {
    try {
      return await streamMessage(running.grpcPort, "what files are there?");
    } catch (e) {
      return null;
    }
  });

  const kinds = (events ?? []).map((e) => e.event?.type).filter(Boolean);
  expect(kinds).toContain("tool_call");
  expect(kinds).toContain("text_delta");
  const toolCall = events!.find((e) => e.event?.type === "tool_call")!;
  expect(toolCall.event).toMatchObject({ type: "tool_call", name: "list_files" });
  const deltas = events!.filter((e) => e.event?.type === "text_delta").map((e) => e.event!.text);
  expect(deltas.join("")).toBe("All done here.");
  // The tool call arrives before the text, and the completed status closes the stream.
  expect(events!.findIndex((e) => e.event?.type === "tool_call")).toBeLessThan(events!.findIndex((e) => e.event?.type === "text_delta"));
  expect(events!.at(-1)?.state).toBe(TaskState.TASK_STATE_COMPLETED);
  expect(events!.some((e) => e.kind === "artifactUpdate" && e.text === "All done here.")).toBe(true);
});
