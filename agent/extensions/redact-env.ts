// Ships with the image: hides the values in `.env` and `.env.*` files (at any depth) from the
// model. Every `KEY=value` line keeps its key and gets `***` for its value, in `read_file` output
// for such a file and in each `search` result line whose path is such a file. `read_files` reads
// through `read_file`, and the subagents use the same file tools, so both are covered. It covers
// the file tools only: `bash` output (`cat .env`) is not redacted.
import { posix } from "node:path";
import type { ExtensionApi } from "../src/extensions.ts";

/** `KEY=value`, with optional leading space and `export `: group 1 is everything up to and including `=`. */
const ASSIGNMENT = /^(\s*(?:export\s+)?[A-Za-z_][A-Za-z0-9_.-]*\s*=).*$/;
/** A `search` result line, `path:line:text`. */
const SEARCH_LINE = /^(.*?):(\d+):(.*)$/;
const MASK = "***";

/** True for `.env` and `.env.<anything>` as the last path segment. */
function isEnvFile(path: string): boolean {
  const name = posix.basename(posix.normalize(path));
  return name === ".env" || name.startsWith(".env.");
}

function redactLine(line: string): string {
  return line.replace(ASSIGNMENT, `$1${MASK}`);
}

function redactSearchLine(line: string): string {
  const m = SEARCH_LINE.exec(line);
  if (!m || !isEnvFile(m[1]!)) return line;
  return `${m[1]}:${m[2]}:${redactLine(m[3]!)}`;
}

export default function (api: ExtensionApi): void {
  api.on("tool_result", async ({ toolName, input, output }) => {
    if (typeof output !== "string") return;
    if (toolName === "read_file") {
      const path = (input as { path?: unknown } | null)?.path;
      if (typeof path !== "string" || !isEnvFile(path)) return;
      return { modify: { output: output.split("\n").map(redactLine).join("\n") } };
    }
    if (toolName === "search") return { modify: { output: output.split("\n").map(redactSearchLine).join("\n") } };
  });
}
