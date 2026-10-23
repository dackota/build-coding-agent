// Ships with the image: the current UTC time, so the model never guesses the date.
import { tool } from "ai";
import { z } from "zod";
import type { ExtensionApi } from "../src/extensions.ts";

export default function (api: ExtensionApi): void {
  api.registerTool("now", () =>
    tool({
      description: "Returns the current UTC date and time in ISO 8601.",
      inputSchema: z.object({}),
      execute: async () => new Date().toISOString(),
    }),
  );
}
