// Shared by extensions-plan/h1.ts..h3.ts. It sits outside that directory so the loader does not load it.
// A write_file path `p<i>--<a1>--<a2>--<a3>.txt` carries the plan; handler k acts on a<k>.
// `mod-<word>` sets the content to <word> and keeps the path, so later handlers still read the plan.
import type { ToolCallHandler } from "../../src/extensions.ts";

export function planHandler(k: number): ToolCallHandler {
  return async ({ toolName, input }) => {
    if (toolName !== "write_file") return;
    const path = String((input as { path?: unknown }).path ?? "");
    const action = path.replace(/\.txt$/, "").split("--")[k] ?? "pass";
    if (action === "throw") throw new Error(`planned throw from h${k}`);
    if (action.startsWith("block-")) return { block: true, reason: action.slice("block-".length) };
    if (action.startsWith("mod-")) return { modify: { input: { ...(input as object), content: action.slice("mod-".length) } } };
  };
}
