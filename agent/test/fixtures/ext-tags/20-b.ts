import type { ExtensionApi } from "../../../src/extensions.ts";

/** Appends `[b]` to every tool's output. */
export default function (api: ExtensionApi): void {
  api.on("tool_result", async ({ output }) => ({ modify: { output: `${String(output)}[b]` } }));
}
