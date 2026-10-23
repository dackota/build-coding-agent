import type { ExtensionApi } from "../../../src/extensions.ts";

/** Input modifies: `read_file README` reads `README.md`; `write_file z.txt` gets a path the schema refuses; `write_file w.txt` gets new content. */
export default function (api: ExtensionApi): void {
  api.on("tool_call", async ({ toolName, input }) => {
    const path = (input as { path?: unknown }).path;
    if (toolName === "read_file" && path === "README") return { modify: { input: { path: "README.md" } } };
    if (toolName === "write_file" && path === "z.txt") return { modify: { input: { path: 42 } } };
    // zod's enum message echoes the received value, so this checks the log never carries it.
    if (toolName === "todo_write") return { modify: { input: { todos: [{ content: "x", status: "SECRET-VALUE-123" }] } } };
    if (toolName === "write_file" && path === "w.txt") return { modify: { input: { ...(input as object), content: "changed" } } };
  });
}
