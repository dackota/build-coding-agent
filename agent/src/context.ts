// Context management: a cap on every tool's output, and pruning of old tool results.
import type { LanguageModelUsage, ModelMessage, Tool } from "ai";
import { log } from "./log.ts";

export const TRUNCATION_MARKER = "[truncated]";
export const PRUNED_MARKER = "[old tool result pruned]";
export const DEFAULT_MAX_TOOL_OUTPUT_CHARS = 20_000;

/** `text` cut so the whole result, marker included, is at most `cap` characters. */
export function capOutput(text: string, cap: number): string {
  if (text.length <= cap) return text;
  return text.slice(0, Math.max(0, cap - TRUNCATION_MARKER.length)) + TRUNCATION_MARKER;
}

/** Every tool's result (and error message) passes through capOutput. Tools without execute are left alone. */
export function capTools<T extends Record<string, Tool>>(tools: T, cap: number): T {
  const wrapped: Record<string, Tool> = {};
  for (const [name, t] of Object.entries(tools)) {
    const execute = t.execute;
    if (!execute) {
      wrapped[name] = t;
      continue;
    }
    wrapped[name] = {
      ...t,
      execute: async (input: unknown, options: never) => {
        try {
          const out: unknown = await execute(input as never, options);
          return capOutput(typeof out === "string" ? out : (JSON.stringify(out) ?? ""), cap);
        } catch (err) {
          throw new Error(capOutput((err as Error).message, cap), { cause: err });
        }
      },
    } as Tool;
  }
  return wrapped as T;
}

/**
 * The messages with every tool result before the latest turn (the last user message and
 * everything after it) replaced by a short marker. Same messages, same order, same call ids:
 * only old results shrink, and the latest turn is never touched.
 */
export function pruneMessages(messages: ModelMessage[]): ModelMessage[] {
  const latestTurn = Math.max(0, messages.map((m) => m.role).lastIndexOf("user"));
  return messages.map((m, i) => {
    if (i >= latestTurn || m.role !== "tool") return m;
    return {
      ...m,
      content: m.content.map((part) =>
        part.type === "tool-result" ? { ...part, output: { type: "text" as const, value: PRUNED_MARKER } } : part,
      ),
    };
  });
}

/** One `step-usage` log line for a model step; `agent` names the subagent when it is not the main agent. */
export function logStepUsage(taskId: string, step: number, usage: LanguageModelUsage, agent?: string): void {
  log("step-usage", {
    taskId,
    step,
    inputTokens: usage.inputTokens ?? 0,
    outputTokens: usage.outputTokens ?? 0,
    cachedTokens: usage.inputTokenDetails?.cacheReadTokens ?? 0,
    ...(agent ? { agent } : {}),
  });
}
