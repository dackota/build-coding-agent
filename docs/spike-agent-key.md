# Spike: a per-agent model key through ModelConfig into agentgateway

Result for the minter, token cap and MCP tickets of the golden path (#49). Tested on kind with
kagent 1.0.0-alpha17, Substrate 0.6.0-alpha3 and agentgateway v1.6.0 (the pinned versions),
on the stock Harness (`kagent-stock`).

## Answer

- **It works, no fallback.** An agent whose ModelConfig names its own key Secret through
  `apiKeySecret` answers through a keyed agentgateway route. The actor holds only the
  placeholder `kagent-credential-injected`; Substrate's egress gateway puts
  `Authorization: Bearer <key>` on the request as it leaves the actor.
- **agentgateway refuses no key and a wrong key** with 401 on the keyed route
  (`apiKeyAuthentication`, mode `Strict`). It holds only the key's hash, in a ConfigMap, with
  `team` and `agent` metadata.
- **The key is not in the actor.** It is absent from the compiled actor env and runtime
  config (`KAGENT_CONFIG_JSON`), from the whole kagent and Substrate database, and from the
  actor's, the controller's and agentgateway's logs. The env holds
  `OPENAI_API_KEY=kagent-credential-injected`.
- **One key for model and MCP works, but not in the same header.** Two credentials for one
  origin and header are rejected, even when they are the same key: an MCP server that sends
  the key as `Authorization` beside the model gets the Agent
  `Compatible=False: conflicting credentials for
  http://agentgateway-proxy.agentgateway-system.svc.cluster.local:80 header authorization`.
  The agent uses its one key on the MCP route in another header, `x-agent-key`, from the same
  Secret and key. Different ports are not needed.

## How the pieces fit

In `platform/spike-agent-key.yaml`:

- **Key Secret** (in the agent's namespace): `OPENAI_API_KEY: <key>`. The script makes it from
  stdin; the minter will too.
- **ModelConfig** `apiKeySecret: <Secret>`, `apiKeySecretKey: OPENAI_API_KEY`, `baseUrl` the
  keyed route. kagent compiles the binding
  `{origin: http://agentgateway-proxy.agentgateway-system.svc.cluster.local:80, header: authorization, prefix: "Bearer ", uri: ate-secret://k8s.io/default/<ns>/<Secret>/OPENAI_API_KEY}`
  (see `kagent.runtime_revision.credentials`).
- **RemoteMCPServer** `headersFrom: [{name: x-agent-key, valueFrom: {type: Secret, name: <Secret>, key: OPENAI_API_KEY}}]`:
  the same Secret and key, a second binding on the same origin with header `x-agent-key` and
  no prefix. The runtime config holds `"x-agent-key": "__KAGENT_ENV[KAGENT_CREDENTIAL_<hash>]__"`.
- **API-key ConfigMap** in `agentgateway-system`, selected by label:
  `<entry>: {"keyHash":"sha256:<hex sha256 of the key>","metadata":{"team":"...","agent":"..."}}`.
  CEL reads the metadata as `apiKey.team` and `apiKey.agent` (ticket 50's MCP rules use
  `apiKey.agent`).
- **Model route**: an `AgentgatewayPolicy` on the HTTPRoute, `traffic.apiKeyAuthentication`
  with `mode: Strict` and `configMapSelector`. It reads `Authorization: Bearer` by default.
  The `opencode-go` backend's own auth then replaces Authorization with the provider key.
- **MCP route**: the same policy shape with `location: {header: {name: x-agent-key}}`, and a
  `RequestHeaderModifier` that removes `x-agent-key`, so the key never reaches the MCP server.

## Findings to carry forward

- **Why the conflict.** kagent compares bindings on origin and header
  (`go/core/internal/egress/credentials.go`), and two bindings merge only when the Secret,
  key and prefix match too. A model binding has prefix `Bearer `; `headersFrom` has none and
  its Secret holds the whole value. So model and MCP can never share `Authorization` on one
  origin. Use `x-agent-key` (or any other header) on every MCP route.
- **The credential grant.** Substrate's credential provider reads Secrets only in the
  namespaces `platform/substrate-values.yaml` grants each atespace. Every team in
  `platform/teams.txt` is granted, so a key Secret must live in the agent's own namespace.
- **The open `/v1` route stays open in this spike.** The spike keys its own paths
  (`/spike-key/v1`, `/spike-key/mcp`). Making `/v1` Strict refuses every agent that still has
  the shared placeholder key (`kagent-openai`), so the minter ticket switches it only once
  every agent has its own key (or uses `mode: Permissive` meanwhile).
- **Our byo image sends no key.** `agent/src/gateway.ts` sets no API key, so on a keyed
  route it would get 401. The byo contract must say: send `Authorization: Bearer
  $OPENAI_API_KEY` (the placeholder) to the model and the MCP header from the runtime config.
  Not tested with our image here.
- **Where to look.** The actor's logs are in the worker pod's logs (`deploy/<pool>` in the
  agent's namespace), labelled `ate.template.name: <agent>-<hash>`. Its compiled env and
  runtime config are the `substrate.actor_templates` proto in kagent's PostgreSQL; the
  bindings are `kagent.runtime_revision.credentials`.
- kagent's docs say the egress gateway caches Secrets for up to five minutes, so a rotated
  key takes up to five minutes to reach the actor's calls. Not tested here.
- kagent's docs also say Secret values do not change the agent's revision, so a minter can
  write or rotate the key after the Agent exists without a recompile. Not tested here.

## Repeat it

On a running cluster (`make up` first). It needs `kubectl`, `curl`, `jq`, `openssl`, `xxd`,
`strings`, and the model key in agentgateway; it spends a few hundred tokens.

```
platform/spike-agent-key.sh
```

It makes a random key, applies `platform/spike-agent-key.yaml` (agent `spike-key` and the
conflict probe `spike-key-conflict` in `team-platform`, the keyed routes and the API-key ConfigMap in
`agentgateway-system`, a one-tool MCP server in namespace `spike-key`), port-forwards the
Gateway on `18090` and the controller on `18091` (`SPIKE_PORT`, `SPIKE_A2A_PORT`), prints one
`PASS` or `FAIL` line per check, and removes it all (`KEEP=1` keeps it). It exits non-zero on
any `FAIL`. The checks, in order:

1. The agent answers a message and its `spike_echo` call returns; agentgateway logged 200 on
   the keyed model route and on `tools/call` on the keyed MCP route; no key header reached the
   MCP server.
2. No key and a wrong key get 401 on both keyed routes; the agent's key gets 200 on the MCP
   route; the open `/v1` route is not 401.
3. The key search finds the key in its own Secret (a control). The compiled actor env holds
   the placeholder for `OPENAI_API_KEY` and an env reference for `x-agent-key`. The key (as
   text, hex, or base64) is absent from the compiled env and runtime config, the whole kagent
   database, and the worker, controller and agentgateway logs since the run began.
4. `spike-key-conflict` (the same key as `Authorization` on its MCP server) is
   `Compatible=False` with `conflicting credentials ... header authorization`.

To poke by hand after `KEEP=1`: `make chat AGENT=spike-key MSG="Call spike_echo with the text
hi"`, or port-forward `svc/agentgateway-proxy` in `agentgateway-system` and POST to
`/spike-key/mcp` with and without `x-agent-key`.
