import type { ExtensionApi } from "../../../src/extensions.ts";

/** A broken policy: its tool_call handler always throws. */
export default function (api: ExtensionApi): void {
  api.on("tool_call", async () => {
    throw new Error("policy exploded");
  });
}
