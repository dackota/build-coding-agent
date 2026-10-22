/** Progress events a turn streams while it runs: carried on a WORKING status message under EVENT_KEY. */
export const EVENT_KEY = "build-coding-agent/event";

export type StreamEvent =
  | { type: "text_delta"; text: string }
  | { type: "tool_call"; name: string; args: unknown };

/** The event on a status message's metadata, or undefined when it carries none (or a malformed one). */
export function readStreamEvent(metadata: Record<string, unknown> | undefined): StreamEvent | undefined {
  const raw = metadata?.[EVENT_KEY] as { type?: unknown; text?: unknown; name?: unknown; args?: unknown } | undefined;
  if (raw?.type === "text_delta" && typeof raw.text === "string") return { type: "text_delta", text: raw.text };
  if (raw?.type === "tool_call" && typeof raw.name === "string") return { type: "tool_call", name: raw.name, args: raw.args };
  return undefined;
}
