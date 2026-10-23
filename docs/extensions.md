# Extensions

An extension adds a tool, or a rule about tools, without changing the agent's core code.
It is one `.ts` file in `agent/extensions/`. The agent loads it at start-up.

Why this shape: [decisions/0002-extensions-events-not-inheritance.md](decisions/0002-extensions-events-not-inheritance.md).

## The ones that ship

| File | Kind | What it does |
|---|---|---|
| `now.ts` | tool | `now` returns the current UTC time. |
| `read-files.ts` | tool | `read_files` reads many files in one call (calls `read_file` per path). |
| `audit.ts` | `tool_call` | Logs a `tool-call` line with the tool name for every call. |
| `protect-env.ts` | `tool_call` | Blocks `write_file` and `edit_file` on any `.env` or `.env.*` file. |
| `redact-env.ts` | `tool_result` | Replaces `.env` values with `***` in `read_file` and `search` output. |

The `.env` rules cover the file tools only. `bash` is covered by its approval gate instead.

## Add a tool

```ts
// agent/extensions/now.ts
import { tool } from "ai";
import { z } from "zod";
import type { ExtensionApi } from "../src/extensions.ts";

export default function (api: ExtensionApi): void {
  api.registerTool("now", (ctx) =>
    tool({
      description: "Current UTC time.",
      inputSchema: z.object({}),
      execute: async () => new Date().toISOString(),
    }));
}
```

- The factory runs once per turn. `ctx.sandbox` is that turn's workspace.
- `ctx.call(name, input)` runs a built-in tool from inside yours, for example
  `await ctx.call("read_file", { path })`. A risky `bash` call through `ctx.call` is refused,
  not run. You cannot `call` custom tools, MCP tools, or `ask_user`.
- Custom tools come after the built-ins. An MCP tool with the same name is dropped.

## Watch, change, or block a tool call

```ts
api.on("tool_call", async ({ toolName, input }) => {
  if (toolName === "write_file" && (input as { path: string }).path === "x.txt") {
    return { block: true, reason: "x.txt is off limits" };
  }
  // return nothing to let the call go on
});
```

`tool_call` runs before the tool. Return:

| Return | Effect |
|---|---|
| nothing | The call goes on. |
| `{ modify: { input } }` | The tool gets the new input. It is checked against the tool's schema again. |
| `{ block: true, reason }` | The tool does not run. The model gets `blocked by <extension>: <reason>`. |

## Change a tool's output

```ts
api.on("tool_result", async ({ toolName, output }) => {
  if (toolName === "read_file") return { modify: { output: `${String(output)}\n[read by the agent]` } };
});
```

`tool_result` runs after the tool. Return nothing to keep the output, or
`{ modify: { output } }` to replace it. The 20000-character output cap applies after this.

## Rules

- **Order.** Files load sorted by name. Handlers run in that order. The first block or error
  ends the chain.
- **Fail closed.** A handler that throws, or returns anything else, stops the tool. The model
  gets `extension <name> failed on <event>`.
- **Every path is covered.** The events fire for built-in, custom, and MCP tools, for inner
  `ctx.call` calls, and for subagent tool calls. You cannot get around a block with `task`.
- **Approvals come first.** A call that needs approval fires `tool_call` only after you approve it.
- **`ask_user` fires no events** (it has no `execute`).
- **Imports.** Use `import type` for anything from `../src/`. Node strips types, so a plain
  import of a type fails at load. The one allowed value import is
  `import { log } from "../src/log.ts"`. Log names and counts only, never tool input or output.
- **Start-up stops** if a tool name is taken, a file has no default function, setup throws,
  or the extensions directory is missing or inside `AGENT_DATA_DIR`.
- **Trusted code only.** Extensions load from the image, never from the workspace.

## Try it

1. Add your file to `agent/extensions/`.
2. Add a test (see `agent/test/extensions.test.ts` and `agent/test/fixtures/ext-*`).
3. `pnpm --dir agent test`
4. `make deploy`. The log shows one `extension-loaded` line per extension, with its tools and events.
