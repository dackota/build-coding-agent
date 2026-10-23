import type { ExtensionApi } from "../../../src/extensions.ts";
import { log } from "../../../src/log.ts";

/** Watches every tool call: logs `fixture-seen` with the tool name, and lets the call go on. */
export default function (api: ExtensionApi): void {
  api.on("tool_call", async ({ toolName }) => {
    log("fixture-seen", { tool: toolName });
  });
}
