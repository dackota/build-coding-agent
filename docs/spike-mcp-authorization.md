# Spike: agentgateway MCP authorization on tool names and arguments

Result for the MCP and GitHub repo tickets of the golden path (#49). Tested on kind with
agentgateway v1.6.0 (the pinned version).

## Answer

- **Per-caller tool allow lists work.** A CEL rule that names the caller's API key metadata
  and its tool names hides the other tools from `tools/list` and refuses them on
  `tools/call` with `Unknown tool: <name>`. Two callers on one endpoint see different tools.
- **`mcp.tool.arguments` does not exist at authorization time in v1.6.0.** A rule that reads
  it (`has(mcp.tool.arguments)`, `mcp.tool.arguments.repo == "x"`) denies every call, and
  `!has(mcp.tool.arguments)` is true. The docs that show it are wrong for this version.
- **A repo rule works anyway through `json(request.body)`.** On `tools/call` the request body
  is readable in the same rule, so the rule can check `params.arguments.owner` and
  `params.arguments.repo`. A call with a repo not on the list is refused (`Unknown tool`).
  `tools/list` has no `params.arguments`, so the rule skips the argument test for any method
  other than `tools/call`.

So the GitHub ticket can use per-agent repo lists in the CEL rule. The tool-name-only
fallback is not needed, but it is the safe floor if a later agentgateway version changes
`request.body` behavior: keep the scripted check below in the guard-rails proof.

## The rule

In `platform/spike-mcp-authz.yaml`, on an `AgentgatewayPolicy` whose `targetRefs` is the
`AgentgatewayBackend` of kind `mcp` (`spec.backend.mcp.authorization`, `action: Allow`).
Each entry of `matchExpressions` is one allow rule; a tool is allowed when any rule is true.

```
apiKey.agent == "alice"
&& mcp.tool.name in ["issue_read", "create_branch"]
&& (json(request.body).method != "tools/call"
    || (json(request.body).params.arguments.owner == "acme"
        && json(request.body).params.arguments.repo in ["good", "fine"]))
```

- The caller comes from a second policy, `traffic.apiKeyAuthentication` (mode `Strict`) on
  the HTTPRoute. Its Secret holds one entry per caller:
  `{"key":"sk-...","metadata":{"agent":"alice"}}`. The metadata reads as `apiKey.agent`.
- Authorization errors count as deny: a rule that fails to evaluate hides the tool.

## Findings to carry forward

- **Hidden is refused.** A hidden tool answers `Unknown tool: <name>` (JSON-RPC `-32602`),
  the same as a tool that does not exist. The caller cannot tell the two apart.
- **No key is 401** at the route, before any MCP rule runs.
- **JSON-RPC batches** (a JSON array body) are rejected by agentgateway (`fail to deserialize
  request body`), so a batch cannot carry a call past the argument test.
- **Duplicate keys in `arguments`** (`{"repo":"evil","repo":"good"}`): the rule and the
  tested server both read the last value. A server that reads the first value would differ.
  Not tested against github-mcp-server; check it when that ticket wires the rule.
- The argument test sees the tool's declared names only (`owner`, `repo`). A tool that
  names the repo another way (a full name, a URL) needs its own rule.
- Policy changes apply in about two seconds; the script sleeps three.

## Repeat it

On a running cluster (`make up` first). It needs `kubectl`, `curl`, and no model key.

```
platform/spike-mcp-authz.sh
```

It applies `platform/spike-mcp-authz.yaml` (namespace `spike-mcp`: a three-tool fake MCP
server, two API keys, the route, and both policies on the existing `agentgateway-proxy`
Gateway at `/spike-mcp`), port-forwards the Gateway on `18080` (`SPIKE_PORT` changes it),
prints one `PASS` or `FAIL` line per check, and deletes the namespace (`KEEP=1` keeps it).
It exits non-zero on any `FAIL`. The checks, in order:

1. alice lists `issue_read,create_branch`; bob lists `issue_read`.
2. bob calling `create_branch`, and alice calling `delete_branch`, answer `Unknown tool`.
3. bob calling `issue_read` runs; a call with no key is 401.
4. alice on `acme/good` runs; on `acme/evil` and `evil/good` is refused.
5. a rule reading `mcp.tool.arguments` denies a good call; its negation allows it.

To poke by hand after `KEEP=1`, port-forward `svc/agentgateway-proxy` in
`agentgateway-system` and send MCP (`initialize`, `notifications/initialized`, then the call)
to `http://127.0.0.1:18080/spike-mcp` with `authorization: Bearer sk-spike-alice` and the
headers `accept: application/json, text/event-stream` and the returned `mcp-session-id`.
