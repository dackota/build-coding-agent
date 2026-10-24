# 0008: MCP authorization at agentgateway, on top of kagent's layers

Status: accepted, 2026-10-24 (golden path, spec #49, spike #50, tickets 55, 56).

## Context

kagent limits a tool by the template's tool list, and Substrate limits reach by egress origin.
Neither stops an agent that holds shell access from calling a tool its template hides, with
`curl`, or from calling a write tool on a repo it should not touch.

## Decision

The catalog MCP servers sit behind agentgateway (`/mcp/github`, `/mcp/demo`). The agent sends
its own key in `x-agent-key`. The minter writes one policy per agent that names the key and
the tools it may see and call; others drop out of `tools/list` and answer `Unknown tool`. A
GitHub write tool also passes only for the repos in `github.repos`, read from the `tools/call`
body (agentgateway v1.6.0 has no `mcp.tool.arguments` at authorization time; spike #50). The
GitHub token moved into the gateway's backend auth, out of every team namespace. The layers
below stay: the template's tool list, egress by origin, credential injection, and the namespace.

## Option that lost

**kagent's tool list alone** (layer 1). It shapes what the model sees, but it does not hold the
server: anything that can reach it can call a tool the template hides, and it cannot look at
a call's arguments. A repo rule on `mcp.tool.arguments` also lost: the gateway does not offer
them at authorization time.

## Consequences

- The repo list is compared as written, so another casing is refused.
- Read tools are not held to the repo list.
- A new MCP server needs a gateway backend and route first; see
  [building on the platform](../building-on-the-platform.md).
