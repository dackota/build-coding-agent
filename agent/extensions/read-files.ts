// Ships with the image: read several files in one call, built by calling `read_file` once per path.
import { tool } from "ai";
import { z } from "zod";
import type { ExtensionApi } from "../src/extensions.ts";

export default function (api: ExtensionApi): void {
  api.registerTool("read_files", (ctx) =>
    tool({
      description: "Reads several workspace files at once. Returns each file's text under its path; a path that cannot be read shows its error in place.",
      inputSchema: z.object({ paths: z.array(z.string()).min(1).describe("Paths relative to the workspace root") }),
      execute: async ({ paths }) => {
        const parts: string[] = [];
        for (const path of paths) {
          try {
            parts.push(`=== ${path} ===\n${String(await ctx.call("read_file", { path }))}`);
          } catch (err) {
            parts.push(`=== ${path} ===\nerror: ${(err as Error).message}`);
          }
        }
        return parts.join("\n\n");
      },
    }),
  );
}
