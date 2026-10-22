# 0002: Extensions are modules in the image, wired by events, not by editing the core

Status: accepted (plan 18, D1 answered A on 2026-10-22)

New tools and tool policies are added as extensions: TypeScript modules in the agent image's extension directory (`AGENT_EXTENSIONS_DIR`, default `/app/extensions`), each default-exporting a setup function that registers custom tools and subscribes to the `tool_call` and `tool_result` lifecycle events. We chose this over a library entry point with a second image, and over editing tools into the core, because it is the course's M11 shape ("events, not inheritance; tools as registrations"), and because a directory baked into the image needs no platform change (the Harness `spec.env` can still point `AGENT_EXTENSIONS_DIR` at another directory in the same image). Extensions are trusted operator code: they load only from the image, never from the model-written workspace, and a bad extension stops startup.

## Consequences

- Every tool call with an `execute` (built-in, custom, or MCP), every call a custom tool makes through `call(...)`, and every tool call a subagent makes goes through the event wrapper: the subagents take their tools from the turn's tool registry. A block or a redaction cannot be stepped around by composition or by the `task` tool.
- `tool_call` fires when a tool is about to execute, so an approval pause (AI SDK `needsApproval`, used by `bash` and by MCP tools on a `requireApproval` binding) comes before it. Output caps apply after `tool_result` handlers.
- The shipped `.env` policies cover the file tools only; `bash` is guarded by its approval gate, not by an extension.
- Session events (start, compaction, shutdown) are not part of the interface yet.
