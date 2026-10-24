# Guard rails

What the platform holds in place for every agent, and cannot be switched off from a values
file. Each row says what is held and links to its proof: a saved output from a run on the
kind cluster (in [proofs/](proofs/)), and the tests that keep it true. The proof files are
the verify runs of the tickets that built each rail, kept as they were saved. A bring-your-own
image gets the same rails; see [the byo contract](byo-contract.md) for what the image itself
must do.

| Rail | What is held | Proof |
|---|---|---|
| **A key per agent** | The model route (`/v1`) takes only an agent key, minted per agent by the minter. No key, a wrong key, or kagent's placeholder gets HTTP 401. | [no key, wrong key, placeholder: 401](proofs/model-route-needs-key.txt), [new folder gets a key](proofs/new-folder-key.txt), [chart test](../agent/test/agent-chart.test.ts) |
| **No credential in the actor** | The actor holds only kagent's placeholder. The agent key is not in its env or runtime config, the kagent database, or the worker, minter and gateway logs. | [key absent, with a control hit](proofs/key-absent-from-actor.txt), [spike](spike-agent-key.md) |
| **Token cap per agent** | `tokenCap` in the values file is a monthly limit enforced at agentgateway. Past it, model calls get HTTP 429. | [429 past the agent cap](proofs/cap-agent.txt), [ratelimit tests](../agent/test/ratelimit-manifests.test.ts), [plan tests](../agent/test/minter-plan.test.ts) |
| **Token cap per team** | The team's budget in `platform/budgets.txt` caps all its agents together, and no team can edit it. A team with no budget gets no keys. | [team cap blocks an agent with room](proofs/cap-team.txt), [no budget, no cap](proofs/cap-no-budget.txt), [status test](../agent/test/caps-status.test.ts) |
| **Tool allow list** | The agent sees and calls only the MCP tools of its catalog names. Any other tool is missing from `tools/list` and answers `Unknown tool`, also to `curl`. | [hidden tool refused](proofs/mcp-hidden-tool.txt), [gateway tests](../agent/test/mcp-gateway.test.ts), [adapter tests](../agent/test/minter-adapter.test.ts) |
| **GitHub token stays at the gateway** | One Secret in `agentgateway-system` holds the token; the gateway's GitHub backend adds it. No team namespace and no actor holds it. | [where the token lives](proofs/github-token-location.txt), [team base test](../agent/test/teams-chart.test.ts) |
| **GitHub repo list** | A GitHub write tool runs only on the repos in `github.repos`. Another repo, other casing, or no list answers `Unknown tool`. The rule reads the call body, because the gateway has no `mcp.tool.arguments` at authorization time ([spike](spike-mcp-authorization.md)). | [listed vs unlisted repos](proofs/github-repo-list.txt), [no list, no write](proofs/github-no-repo-list.txt), [plan tests](../agent/test/minter-plan.test.ts) |
| **Write tools need approval** | The schema refuses `requireApproval: false` on a write tool, so the human pauses on every call. | [chart test](../agent/test/agent-chart.test.ts), [approval test](../agent/test/mcp-approval.test.ts) |
| **Teams stay in their lane** | Each team deploys only into `team-<team>`, from this repo, with no cluster-scoped kinds. The values file schema refuses unknown fields. The team base is platform-owned. | [agents sit in team namespaces](proofs/namespaces-and-agents.txt), [team chart tests](../agent/test/teams-chart.test.ts), [team list test](../agent/test/teams.test.ts) |
| **The minter has narrow RBAC** | It lists, creates and deletes Secrets only in team namespaces, and patches only `agent-api-keys` in `agentgateway-system`. No cluster-wide Secret access. | [what the minter can do](proofs/minter-rbac.txt), [minter chart test](../agent/test/minter-chart.test.ts) |
| **Delete removes everything** | Deleting an agent's folder removes the agent, its registration, key Secret, key hash, cap and tool policy. | [folder deleted, all gone](proofs/delete-folder.txt), [cap removed](proofs/cap-delete.txt) |
| **byo parity and check** | A `byo` agent gets the same key, cap, tool list and egress as any other. `make byo-check` reports pass or fail per contract rule and leaves nothing behind. | [starter passes](proofs/byo-check-starter.txt), [a bad image fails](proofs/byo-check-fail.txt), [byo chart test](../agent/test/byo-chart.test.ts), [check tests](../agent/test/byo-check.test.ts) |

## Known gaps

- **Caps count tokens in a 30 day window**, not a calendar month, and a changed cap takes a few
  minutes to apply (the minter runs each minute, then the ratelimit service reloads).
- **Repo names are compared as written.** GitHub ignores case; the gateway does not, so a call
  with other casing is refused (fail closed).
- **Read tools are not held to the repo list.** The list covers repos an agent may change.
- **Image trust for `byo` is an allow list plus a digest pin.** There is no signature check
  yet; see [the Later list](later.md).
- **The reusable image build workflow** has been checked with actionlint and a structural test,
  not yet run from a caller on GitHub.
