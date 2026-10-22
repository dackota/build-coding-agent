# Platform

A local kind cluster with Agent Substrate, kagent 1.x, agentgateway in front of the
OpenCode Go plan, and a local registry. Versions and digests: `versions.env`, explained
in `docs/pinned-versions.md`.

| Command | What it does |
|---|---|
| `make up` | `preflight.sh` (tools, versions, `OPENCODE_KEY`), then `cluster.sh up` (registry `registry:2` on `localhost:5001`, kind cluster `build-coding-agent` from kagent's kind config, registry joined to the `kind` network), then `install.sh` (Substrate and kagent through the pinned kagent CLI, Gateway API CRDs, agentgateway, the key Secret, and kagent's stock agent). Safe to run again. |
| `make status` | One `ok` or `FAIL` line each for the cluster, the registry, Substrate, kagent, agentgateway, the model route, the stock agent, and the image pins. |
| `make smoke` | Pushes a tiny image to `localhost:5001`, applies Harness `registry-smoke` with `image@sha256:<digest>`, and sends one message to `stock-agent` through agentgateway (spends model tokens). |
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

## Files

- `kind-config.yaml`: kagent's own kind config from the pinned release, unchanged.
- `kagent-values.yaml`: kagent chart values (model through the gateway).
- `gateway.yaml`: the Gateway, the OpenCode Go backend, and the `/v1` route.
- `stock-agent.yaml`: Harness `kagent-stock` (kagent's built-in runtime), AgentTemplate and Agent `stock-agent`.
- `images.lock`: every image the platform runs, by digest.
