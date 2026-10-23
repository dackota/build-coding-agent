# build-coding-agent

A TypeScript coding agent that runs as a kagent 1.x `byo` agent on Agent Substrate. These are the extension terms plan 18 adds; the orchestrator merges them into a root `GLOSSARY.md` (none exists yet).

## Extensibility

**Extension**:
A TypeScript module in the agent image's extension directory whose default export registers custom tools and lifecycle event handlers at startup.
_Avoid_: plugin, hook module, add-on

**Built-in tool**:
A tool the agent itself provides (`read_file`, `write_file`, `edit_file`, `search`, `bash`, `ask_user`, `todo_write`, `load_skill` on turns whose workspace has skills, `task` when the config has subagents), registered before any extension loads. Its name is reserved on every turn, whether or not the tool exists that turn. An MCP tool (from a binding in the kagent config) is not a built-in tool.
_Avoid_: core tool, native tool

**Custom tool**:
A tool registered by an extension; the model calls it like a built-in tool, and it may compose built-in tools.
_Avoid_: plugin tool, user tool

**Tool registry**:
The ordered set of named tool factories a turn's tools are built from: the turn's MCP tools, then the built-in tools, then the custom tools. The subagents' tools come from the same built set.
_Avoid_: toolbox, tool map

**Lifecycle event**:
A named point in a tool call (`tool_call` before it runs, `tool_result` after) where extension handlers can watch, block, or change it.
_Avoid_: hook (the `Sandbox` lifecycle hooks `afterStart`, `beforeStop`, `onTimeout` are a different thing), callback, middleware

**Block**:
A `tool_call` handler's refusal of one call, with a reason the model gets as the tool result; the tool does not run.
_Avoid_: deny (that is a user's approval answer), veto

**Modify**:
A handler's replacement of a tool call's input (`tool_call`, checked again against the tool's input schema) or of its output (`tool_result`); later handlers, the tool, and the model see the replacement.
_Avoid_: rewrite, patch, transform
