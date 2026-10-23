# Platform

Scripts and manifests for the local cluster: kind, Agent Substrate, kagent 1.x,
agentgateway, a local registry, and the MCP servers the agent uses.

What each piece is and why: [../docs/how-it-works.md](../docs/how-it-works.md).

The kube context is `kind-build-coding-agent`. Every script passes `--context` (kubectl) or
`--kube-context` (helm) on every call. The kagent CLI does not take a context, so
`install.sh` gives it a kubeconfig that holds only this cluster
(`.bin/kind-build-coding-agent.kubeconfig`).

## Make targets

| Command | What it does |
|---|---|
| `make preflight` | Checks tools, versions, and `OPENCODE_KEY`. Creates nothing. |
| `make up` | Preflight, then creates the registry (`localhost:5001`) and the kind cluster, then installs Substrate and kagent (through the pinned kagent CLI), Gateway API CRDs, agentgateway, the key Secret, and kagent's stock agent. Safe to run again. |
| `make status` | One `ok` or `FAIL` line each for the cluster, registry, Substrate, kagent, agentgateway, model route, stock agent, triage-agent and docs-agent (after `make deploy`), and image pins. Exits non-zero on any `FAIL`. |
| `make smoke` | Proves the platform without our agent: pushes a tiny image, runs it in a Harness by digest, and sends one message to `stock-agent`. Spends model tokens. |
| `make deploy` | Makes the GitHub token Secret, builds and pushes the agent image, applies the MCP servers and egress policy, then applies `agent.yaml.tmpl` by image digest. Waits for the Agent to be Ready. |
| `make chat MSG=...` | Sends one message to `hello-agent`. See [../docs/using-the-agent.md](../docs/using-the-agent.md). |
| `make down` | Deletes the cluster and the registry. |

## Secrets

Both live in `.env` in the main checkout. Set `ENV_FILE=<path>` to use another file.

| Key | Goes to | Read by |
|---|---|---|
| `OPENCODE_KEY` | Secret `agentgateway-system/opencode-go-key` (`make up`) | agentgateway only. kagent holds a placeholder key and calls the gateway's `/v1`. |
| `GITHUB_TOKEN` | Secret `github-mcp/github-mcp-token` (`make deploy`) | The GitHub MCP auth proxy only. |

The scripts pipe each value to `kubectl create secret` on stdin. It is never printed,
written to disk, or put on a command line.

## Files

| File | What it is |
|---|---|
| `versions.env` | Every pinned version and digest. See [../docs/pinned-versions.md](../docs/pinned-versions.md). |
| `images.lock` | Every image the platform runs, by digest. `make status` checks against it. |
| `preflight.sh`, `cluster.sh`, `install.sh`, `status.sh`, `smoke.sh`, `deploy.sh`, `lib.sh` | The scripts behind the make targets. `lib.sh` is shared helpers. |
| `kind-config.yaml` | kagent's own kind config from the pinned release, unchanged. |
| `kagent-values.yaml` | kagent chart values. Points the model at the gateway. |
| `gateway.yaml` | The Gateway, the OpenCode Go backend, and the `/v1` route. |
| `stock-agent.yaml` | kagent's built-in agent, used by `make smoke` and `make status`. |
| `triage-agent.yaml` | `triage-agent` on the stock runtime: reads a GitHub issue with `issue_read` and decides. Applied by `make deploy`. |
| `docs-agent.yaml` | `docs-agent`: AgentTemplate and Agent on `hello-harness` (Recipe 2). |
| `agent.yaml.tmpl` | Our agent: Harness, ModelConfigs, AgentTemplates (`hello-agent` and the `explorer`, `executor`, `reviewer` subagents), and Agent `hello-agent`. `deploy.sh` fills in `@IMAGE@`. |
| `github-mcp.yaml` | GitHub's MCP server with only `issue_read`, `create_branch`, `push_files`, `create_pull_request`, behind the auth proxy. |
| `github-mcp-proxy.mjs` | The auth proxy. Adds the token to every request and drops any `Authorization` a caller sends. |
| `demo-mcp.yaml` | A one-tool MCP server (`delete_branch`, which deletes nothing). Shows that approvals work. |
| `egress.yaml` | Lets the agent's actor reach `github.com`, `codeload.github.com` and `registry.npmjs.org` over HTTPS. |

## Why the image name is not `localhost:5001`

The Harness names the image by the registry's address on the kind network (for example
`172.19.0.3:5000/hello-agent@sha256:...`). Substrate pulls images from inside the cluster,
where `localhost:5001` is not the registry. It also speaks plain HTTP only to a private IP.

## Debug

```sh
make status
kubectl --context kind-build-coding-agent -n agents get agents.api.kagent.dev,harnesses.api.kagent.dev
kubectl --context kind-build-coding-agent -n github-mcp logs deploy/github-mcp -c auth-proxy
kubectl --context kind-build-coding-agent -n demo-mcp logs deploy/demo-mcp
```

The auth proxy logs method, path, and status per request. The demo server logs a
`tools-call` line per call, so you can see if an approval was honoured.
