# Platform

A local kind cluster with Agent Substrate, kagent 1.x, agentgateway in front of the
OpenCode Go plan, and a local registry. Versions and digests: `versions.env`, explained
in `docs/pinned-versions.md`.

| Command | What it does |
|---|---|
| `make up` | `preflight.sh` (tools, versions, `OPENCODE_KEY`), then `cluster.sh up` (registry `registry:2` on `localhost:5001`, kind cluster `build-coding-agent` from kagent's kind config, registry joined to the `kind` network), then `install.sh` (Substrate and kagent through the pinned kagent CLI, Gateway API CRDs, agentgateway, the key Secret, and kagent's stock agent). Safe to run again. |
| `make status` | One `ok` or `FAIL` line each for the cluster, the registry, Substrate, kagent, agentgateway, the model route, the stock agent, and the image pins. |
| `make smoke` | Pushes a tiny image to `localhost:5001`, applies Harness `registry-smoke` with `image@sha256:<digest>`, and sends one message to `stock-agent` through agentgateway (spends model tokens). |
| `make deploy` | `deploy.sh`: makes Secret `github-mcp/github-mcp-token` from `GITHUB_TOKEN` (fails when it is empty), builds `agent/`, pushes it through `localhost:5001`, reads the sha256 digest from the registry, applies `demo-mcp.yaml` and `github-mcp.yaml` and waits for them, then applies `agent.yaml.tmpl` (Harness, AgentTemplates `hello-agent`, the subagents `explorer-template` and `executor-template`, and the read-only `reviewer-template`, Agent `hello-agent`) with the image named by that digest. Waits for the Agent to be Ready. |
| `make chat MSG=...` | Sends one message to `hello-agent` through the kagent controller (the agent CLI in `agent/`). When the agent asks a question, the CLI prints it with the ids to answer with (`agent/README.md`). |
| `make down` | Deletes the cluster and the registry container. |

The kube context is `kind-build-coding-agent`. Scripts call `kubectl --context` and
`helm --kube-context` on every call. The kagent CLI calls helm and kubectl without a
context, so `install.sh` runs it with a kubeconfig (`.bin/kind-build-coding-agent.kubeconfig`)
that holds only this cluster.

## The key

Put `OPENCODE_KEY=...` in `.env` in the main checkout (see `.env.example`); worktrees
share it. `ENV_FILE=<path>` points the scripts at another file. `install.sh` pipes the
value to `kubectl create secret` on stdin as Secret `agentgateway-system/opencode-go-key`;
it is never printed, written to disk, or put on a command line. kagent itself holds
only a placeholder key: its `default-model-config` points at the gateway's `/v1`.

`GITHUB_TOKEN=...` in the same file is a fine-grained GitHub token for the repos the agent
may push to. `deploy.sh` pipes it the same way into Secret `github-mcp/github-mcp-token`,
which only the GitHub MCP server's auth proxy reads. The agent's config, env and logs
never hold it.

## Files

- `kind-config.yaml`: kagent's own kind config from the pinned release, unchanged.
- `kagent-values.yaml`: kagent chart values (model through the gateway).
- `gateway.yaml`: the Gateway, the OpenCode Go backend, and the `/v1` route.
- `stock-agent.yaml`: Harness `kagent-stock` (kagent's built-in runtime), AgentTemplate and Agent `stock-agent`.
- `agent.yaml.tmpl`: the hello byo agent (Harness, AgentTemplate, Agent). No key: the agent reaches the model through `default-model-config` and the gateway. The AgentTemplate binds `demo-mcp`'s `delete_branch`, and `github-mcp`'s `create_branch`, `push_files` and `create_pull_request`, each with `requireApproval: true`.
- `github-mcp.yaml`: git out. `github-mcp-server` (`GITHUB_MCP_IMAGE` in `versions.env`) in http mode on the pod's loopback with only `issue_read`, `create_branch`, `push_files` and `create_pull_request` (the model is bound the last three; the implement loop calls all four from code), behind `github-mcp-proxy.mjs` (port 8080, on `NODE_IMAGE`), which adds the token from Secret `github-mcp-token` to every request and replaces any `Authorization` a caller sends. The RemoteMCPServer `github-mcp` in `kagent` names the proxy and has no headers, so kagent copies no credential into the agent's config. The proxy logs method, path and status per request (`kubectl --context kind-build-coding-agent -n github-mcp logs deploy/github-mcp -c auth-proxy`).
- `demo-mcp.yaml`: a one-tool MCP server (`delete_branch`, which deletes nothing) in namespace `demo-mcp`, on the agent image's pinned `node:24-slim` (`NODE_IMAGE` in `versions.env`, filled in by `deploy.sh`; `make status` checks the running digest against `images.lock`), with its RemoteMCPServer in `kagent`. Its log has a `tools-call` line for every call, so `kubectl --context kind-build-coding-agent -n demo-mcp logs deploy/demo-mcp` shows whether an approval was honoured.
- `egress.yaml`: an `EgressPolicy` in `kagent` that lets the agent's actor reach `github.com`, `codeload.github.com` and `registry.npmjs.org` over HTTPS (DNS names, no authentication, so no credential and public repos only). `deploy.sh` applies it.
- `deploy.sh`: builds and pins the agent image. The Harness names the image by the registry's address on the kind network (for example `172.19.0.3:5000/hello-agent@sha256:...`), not `localhost:5001`: Substrate's atelet pulls images from inside the cluster, where `localhost:5001` is not the registry, and it speaks plain HTTP only to a private IP.
- `images.lock`: every image the platform runs, by digest.
