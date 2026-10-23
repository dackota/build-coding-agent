import type { ExtensionApi } from "../../../src/extensions.ts";

/** Blocks `read_file` on `secret.txt`. */
export default function (api: ExtensionApi): void {
  api.on("tool_call", async ({ toolName, input }) => {
    if (toolName === "read_file" && (input as { path?: string }).path === "secret.txt") return { block: true, reason: "secret.txt is private" };
  });
}
