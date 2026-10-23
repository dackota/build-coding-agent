import { tool } from "ai";
import { z } from "zod";
import type { ExtensionApi } from "../../../src/extensions.ts";

export default function (api: ExtensionApi): void {
  api.registerTool("echo", () => tool({ description: "Echo the text back.", inputSchema: z.object({ text: z.string() }), execute: async ({ text }) => text }));
}
