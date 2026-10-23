// Tools from the MCP servers bound in the kagent config (agent.http_tools, agent.sse_tools).
// Each turn opens its own clients and closes them after: a wake from a snapshot never meets a
// stale connection. A tool on a binding with requireApproval pauses before every call, as the
// shell does: needsApproval makes the AI SDK pause the turn, and execute checks the gate again,
// so no path calls the MCP server unapproved.
import { createMCPClient, type MCPClient } from "@ai-sdk/mcp";
import type { Tool, ToolExecutionOptions } from "ai";
import type { McpBinding } from "./config.ts";
import { log } from "./log.ts";
import type { ApprovalGate } from "./shell-tool.ts";

export type McpTools = { tools: Record<string, Tool>; close: () => Promise<void> };

/** The risk kind of an MCP tool: "approve for this session" approves it by name. */
export const mcpKind = (toolName: string): string => `mcp:${toolName}`;

/** The tool with a human gate in front of every call. */
function gated(name: string, original: Tool, gate: ApprovalGate): Tool {
  const kinds = [mcpKind(name)];
  const execute = original.execute!;
  return {
    ...original,
    needsApproval: async (_input: unknown, { toolCallId }: { toolCallId: string }) =>
      gate.isDecided?.(toolCallId) === true || !gate.allows(toolCallId, kinds),
    execute: async (input: unknown, options: ToolExecutionOptions) => {
      if (!gate.allows(options.toolCallId, kinds)) {
        log("mcp-refused", { toolCallId: options.toolCallId, tool: name });
        throw new Error(`refused: ${name} needs the user's approval and has none`);
      }
      return execute(input as never, options);
    },
  } as Tool;
}

type CallResult = { content?: { type: string; text?: string }[]; isError?: boolean };

/** An MCP call result as text: its text parts, and any other part as JSON. An error result throws. */
function resultText(result: unknown): string {
  const { content = [], isError } = (result ?? {}) as CallResult;
  const text = content.map((part) => (part.type === "text" ? (part.text ?? "") : JSON.stringify(part))).join("\n");
  if (isError) throw new Error(text || "the MCP tool reported an error");
  return text;
}

/**
 * The tool with one log line per call, so the agent's log shows each MCP call it made, and its
 * result as text (the output cap in context.ts works on text, so the MCP tool's own
 * object-to-model mapping is dropped).
 */
function logged(name: string, original: Tool): Tool {
  const execute = original.execute!;
  return {
    ...original,
    toModelOutput: undefined,
    execute: async (input: unknown, options: ToolExecutionOptions) => {
      log("mcp-call", { toolCallId: options.toolCallId, tool: name });
      return resultText(await execute(input as never, options));
    },
  } as Tool;
}

/** The binding's tools, gated when it requires approval. Undefined when the server cannot be reached. */
async function openBinding(binding: McpBinding, gate: ApprovalGate): Promise<{ client: MCPClient; tools: Record<string, Tool> } | undefined> {
  let client: MCPClient | undefined;
  try {
    client = await createMCPClient({ transport: { type: binding.transport, url: binding.url, headers: binding.headers } });
    const all = (await client.tools()) as Record<string, Tool>;
    const tools: Record<string, Tool> = {};
    for (const [name, t] of Object.entries(all)) {
      if (binding.tools.length > 0 && !binding.tools.includes(name)) continue;
      tools[name] = logged(name, binding.requireApproval ? gated(name, t, gate) : t);
    }
    return { client, tools };
  } catch (err) {
    // A server that is down costs its tools for this turn, not the turn.
    log("mcp-unavailable", { url: binding.url, message: (err as Error).message });
    await client?.close().catch((closeErr: Error) => log("mcp-close-failed", { message: closeErr.message }));
    return undefined;
  }
}

/** Opens every binding's server for one turn; close() closes them all. */
export async function openMcpTools(bindings: readonly McpBinding[], gate: ApprovalGate): Promise<McpTools> {
  const opened = (await Promise.all(bindings.map((b) => openBinding(b, gate)))).filter((o) => o !== undefined);
  return {
    tools: Object.assign({}, ...opened.map((o) => o.tools)) as Record<string, Tool>,
    close: async () => {
      await Promise.all(opened.map((o) => o.client.close().catch((err: Error) => log("mcp-close-failed", { message: err.message }))));
    },
  };
}
