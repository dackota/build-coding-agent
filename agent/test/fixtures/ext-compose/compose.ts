import { tool } from "ai";
import { z } from "zod";
import type { ExtensionApi } from "../../../src/extensions.ts";

/** `compose` runs whichever tool the model names through the extension API's `call`. `inner_custom` is a custom tool, which `call` must refuse. */
export default function (api: ExtensionApi): void {
  api.registerTool("inner_custom", () => tool({ description: "A custom tool.", inputSchema: z.object({}), execute: async () => "inner" }));
  api.registerTool("compose", (ctx) =>
    tool({
      description: "Calls another tool.",
      inputSchema: z.object({ name: z.string(), input: z.record(z.string(), z.unknown()) }),
      execute: async ({ name, input }) => ctx.call(name, input),
    }),
  );
}
