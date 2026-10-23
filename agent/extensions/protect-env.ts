// Ships with the image: blocks `write_file` and `edit_file` on a `.env` or `.env.*` file at any
// depth (`.env`, `app/.env.local`, `.env.example`). It covers the file tools only: a `bash` command
// that writes such a file is a risky command, so it pauses for the user's approval instead, and once
// approved it is not blocked here.
import { posix } from "node:path";
import type { ExtensionApi } from "../src/extensions.ts";

const GUARDED_TOOLS = new Set(["write_file", "edit_file"]);

/** True for `.env` and `.env.<anything>` as the last path segment. */
function isEnvFile(path: string): boolean {
  const name = posix.basename(posix.normalize(path));
  return name === ".env" || name.startsWith(".env.");
}

export default function (api: ExtensionApi): void {
  api.on("tool_call", async ({ toolName, input }) => {
    if (!GUARDED_TOOLS.has(toolName)) return;
    const path = (input as { path?: unknown } | null)?.path;
    if (typeof path === "string" && isEnvFile(path)) {
      return { block: true, reason: ".env files hold secrets and are protected; do not write or edit them. Tell the user which values to set instead." };
    }
  });
}
