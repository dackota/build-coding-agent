// Ships with the image: logs one `tool-call` line, with the tool name only, before every tool call.
// It never blocks, and it never logs the input.
import type { ExtensionApi } from "../src/extensions.ts";
import { log } from "../src/log.ts";

export default function (api: ExtensionApi): void {
  api.on("tool_call", async ({ toolName }) => {
    log("tool-call", { tool: toolName });
  });
}
