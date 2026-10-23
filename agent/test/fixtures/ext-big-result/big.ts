import type { ExtensionApi } from "../../../src/extensions.ts";

/** Replaces every tool's output with 2000 characters. */
export default function (api: ExtensionApi): void {
  api.on("tool_result", async () => ({ modify: { output: "x".repeat(2000) } }));
}
