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
| `make up` | Preflight, then creates the registry (`localhost:5001`) and the kind cluster, then installs Substrate and kagent (through the pinned kagent CLI), Gateway API CRDs, agentgateway, the key Secret, Argo CD, and the teams of `teams.txt`. Argo CD then deploys every `deployments/<team>/<agent>/`. Deletes the one shared agents namespace that clusters built before the teams had. Safe to run again; it keeps the image pins of `make deploy`. `GITOPS_REVISION=<branch> make up` points Argo CD at a branch instead of `main`. |
| `make status` | One `ok` or `FAIL` line each for the cluster, registry, Substrate, kagent, agentgateway, model route, Argo CD and its ApplicationSet, each team base, the platform team's `triage-agent`, `docs-agent` and `hello-agent` (after `make deploy`), and image pins. Exits non-zero on any `FAIL`. |
| `make smoke` | Proves the platform without our image: pushes a tiny image, runs it in a Harness by digest in `team-platform`, and sends one message to `triage-agent` (stock runtime). Spends model tokens. |
| `make deploy` | Makes each team's GitHub token Secret, builds and pushes the coding agent image and each skill image, runs the MCP servers, and pins the images by digest in the teams release: every team base's Harness `coding`, and the skill images every Application gets. Waits for the platform team's agents to be Ready. |
| `make chat MSG=...` | Sends one message to `hello-agent` in `team-platform`; `TEAM=<team> AGENT=<agent>` talks to another agent (`TEAM` defaults to `platform`). See [../docs/using-the-agent.md](../docs/using-the-agent.md). |
| `make down` | Deletes the cluster and the registry. |

## Secrets

Both live in `.env` in the main checkout. Set `ENV_FILE=<path>` to use another file.

| Key | Goes to | Read by |
|---|---|---|
| `OPENCODE_KEY` | Secret `agentgateway-system/opencode-go-key` (`make up`) | agentgateway only. kagent holds a placeholder key and calls the gateway's `/v1`. |
| `GITHUB_TOKEN` | Secret `github-mcp-token` in each team namespace, value `Bearer <token>` (`make deploy`) | Substrate's egress gateway only. It adds the header to the agents' `github-mcp` requests (`headersFrom` on the team base's RemoteMCPServer). |

The scripts pipe each value to `kubectl create secret` on stdin. It is never printed,
written to disk, or put on a command line.

## Files

| File | What it is |
|---|---|
| `versions.env` | Every pinned version and digest. See [../docs/pinned-versions.md](../docs/pinned-versions.md). |
| `images.lock` | Every image the platform runs, by digest. `make status` checks against it. |
| `preflight.sh`, `cluster.sh`, `install.sh`, `status.sh`, `smoke.sh`, `deploy.sh`, `lib.sh` | The scripts behind the make targets. `lib.sh` is shared helpers. |
| `teams.txt`, `teams.sh` | The one team list, and the script that reads it for `make up` (the teams chart and Substrate's namespace lists) and `make status`. Adding a team needs `make down` and `make up`. |
| `charts/teams/` | Per team: namespace `team-<team>`, its team base (WorkerPool and ServiceAccount `team-default`, `default-model-config`, Harness `kagent-stock`, Harness `coding` once `make deploy` pins its image, subagent templates `explorer-template`, `executor-template`, `reviewer-template` and their ModelConfigs, RemoteMCPServers `github-mcp` and `demo-mcp`, EgressPolicies `git-egress` and `npm-egress`), and Argo CD AppProject `team-<team>` (this repo only, that namespace only, no cluster-scoped kinds). Plus the ApplicationSet `agents`: one Application per `deployments/<team>/<agent>/`. |
| `charts/agent/` | The values-file chart: renders one agent's AgentTemplate, Agent, and registration ConfigMap, with its subagents, catalog tools and skills by name. `values.schema.json` is the contract. See [../deployments/README.md](../deployments/README.md). |
| `argocd-values.yaml` | Argo CD chart values (no Dex, no notifications). |
| `kind-config.yaml` | kagent's own kind config from the pinned release, unchanged. |
| `kagent-values.yaml` | kagent chart values. Points the model at the gateway. |
| `gateway.yaml` | The Gateway, the OpenCode Go backend, and the `/v1` route. |
| `skills/<name>/SKILL.md` | The skills a values file picks by name (`skills: [docs-style]`). `make deploy` builds one image per skill. |
| `github-mcp.yaml` | GitHub's MCP server with only `issue_read`, `create_branch`, `push_files`, `create_pull_request` (catalog tools `github-read` and `github-write`). It refuses a request with no token. The team base's RemoteMCPServer takes `Authorization` from Secret `github-mcp-token`. |
| `demo-mcp.yaml` | A one-tool MCP server (`delete_branch`, which deletes nothing; catalog tool `demo-delete-branch`). Shows that approvals work. |

The platform team's own agents (`hello-agent`, `docs-agent`, `triage-agent`) are values
files in [../deployments/platform/](../deployments/platform/), deployed by Argo CD like any
team's.

## Why the image name is not `localhost:5001`

The Harness names the image by the registry's address on the kind network (for example
`172.19.0.3:5000/hello-agent@sha256:...`). Substrate pulls images from inside the cluster,
where `localhost:5001` is not the registry. It also speaks plain HTTP only to a private IP.

## Debug

```sh
make status
kubectl --context kind-build-coding-agent -n team-platform get agents.api.kagent.dev,harnesses.api.kagent.dev
kubectl --context kind-build-coding-agent -n argocd get applications
kubectl --context kind-build-coding-agent -n github-mcp logs deploy/github-mcp
kubectl --context kind-build-coding-agent -n demo-mcp logs deploy/demo-mcp
```

The GitHub MCP server logs a line per session. The demo server logs a
`tools-call` line per call, so you can see if an approval was honoured.
