/** Progress events a turn streams while it runs: carried on a WORKING status message under EVENT_KEY. */
export const EVENT_KEY = "build-coding-agent/event";

export type StreamEvent =
  | { type: "text_delta"; text: string }
  | { type: "tool_call"; name: string; args: unknown }
  /** One step of an implement run: its name, the round, and how it ended ("ok" or a short code). */
  | { type: "loop_step"; step: string; round: number; result: string };

/** The event on a status message's metadata, or undefined when it carries none (or a malformed one). */
export function readStreamEvent(metadata: Record<string, unknown> | undefined): StreamEvent | undefined {
  const raw = metadata?.[EVENT_KEY] as { type?: unknown; text?: unknown; name?: unknown; args?: unknown; step?: unknown; round?: unknown; result?: unknown } | undefined;
  if (raw?.type === "text_delta" && typeof raw.text === "string") return { type: "text_delta", text: raw.text };
  if (raw?.type === "tool_call" && typeof raw.name === "string") return { type: "tool_call", name: raw.name, args: raw.args };
  if (raw?.type === "loop_step" && typeof raw.step === "string" && typeof raw.round === "number" && typeof raw.result === "string") {
    return { type: "loop_step", step: raw.step, round: raw.round, result: raw.result };
  }
  return undefined;
}
