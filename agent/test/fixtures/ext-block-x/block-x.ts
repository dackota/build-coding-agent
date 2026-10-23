import type { ExtensionApi } from "../../../src/extensions.ts";

/** Blocks `write_file` on `x.txt`; every other call goes on. */
export default function (api: ExtensionApi): void {
  api.on("tool_call", async ({ toolName, input }) => {
    if (toolName === "write_file" && (input as { path?: string }).path === "x.txt") return { block: true, reason: "x.txt is off limits" };
  });
}
