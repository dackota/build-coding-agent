import type { ModelMessage } from "ai";
import fc from "fast-check";
import { expect, it } from "vitest";
import { capOutput, PRUNED_MARKER, pruneMessages, TRUNCATION_MARKER } from "../src/context.ts";

const MIN_CAP = TRUNCATION_MARKER.length + 1;

it("capOutput never returns more than the cap, and leaves short text alone", () => {
  fc.assert(
    fc.property(fc.string({ unit: "binary" }), fc.integer({ min: MIN_CAP, max: 5000 }), (text, cap) => {
      const out = capOutput(text, cap);
      expect(out.length).toBeLessThanOrEqual(cap);
      if (text.length <= cap) expect(out).toBe(text);
      else expect(out).toContain(TRUNCATION_MARKER);
    }),
  );
});

it("capOutput holds for a huge input at a tiny cap", () => {
  expect(capOutput("x".repeat(1_000_000), MIN_CAP).length).toBeLessThanOrEqual(MIN_CAP);
});

const toolResult = (id: string, value: string): ModelMessage => ({
  role: "tool",
  content: [{ type: "tool-result", toolCallId: id, toolName: "read_file", output: { type: "text", value } }],
});
const toolCall = (id: string): ModelMessage => ({
  role: "assistant",
  content: [{ type: "tool-call", toolCallId: id, toolName: "read_file", input: { path: "a" } }],
});

const messageArb: fc.Arbitrary<ModelMessage[]> = fc
  .array(fc.oneof(fc.constant("user"), fc.constant("tool")), { maxLength: 12 })
  .map((kinds) => {
    const out: ModelMessage[] = [];
    kinds.forEach((k, i) => {
      if (k === "user") out.push({ role: "user", content: `u${i}` });
      else out.push(toolCall(`c${i}`), toolResult(`c${i}`, `result ${i} `.repeat(50)));
    });
    return out;
  });

it("pruneMessages never changes the latest turn nor the message count", () => {
  fc.assert(
    fc.property(messageArb, (messages) => {
      const out = pruneMessages(messages);
      expect(out).toHaveLength(messages.length);
      const lastUser = messages.map((m) => m.role).lastIndexOf("user");
      const from = lastUser === -1 ? 0 : lastUser;
      expect(out.slice(from)).toEqual(messages.slice(from));
    }),
  );
});

it("pruneMessages replaces tool results before the latest turn, keeping the call ids", () => {
  const messages: ModelMessage[] = [
    { role: "user", content: "first" },
    toolCall("c1"),
    toolResult("c1", "BIG OLD RESULT"),
    { role: "assistant", content: "ok" },
    { role: "user", content: "second" },
    toolCall("c2"),
    toolResult("c2", "NEW RESULT"),
  ];
  const out = pruneMessages(messages);
  const json = JSON.stringify(out);
  expect(json).not.toContain("BIG OLD RESULT");
  expect(json).toContain(PRUNED_MARKER);
  expect(json).toContain('"toolCallId":"c1"');
  expect(json).toContain("NEW RESULT");
});
