# Building on the platform

How to add your own agents, tools, and models to the cluster `make up` builds.

**To ship an agent, write a values file**, not kagent YAML:
`deployments/<team>/<agent>/values.yaml`, deployed by Argo CD into `team-<team>`. See
[../deployments/README.md](../deployments/README.md). Recipes 1 and 2 below are values files.
The other recipes show the kagent objects underneath. They are platform changes: the team
base in `platform/charts/teams/` (every team namespace gets its own copy) or the catalog in
`platform/charts/agent/`. A team cannot apply them: its Argo CD project allows only the
kinds the values-file chart renders.

All resources here are `api.kagent.dev/v1alpha3` in a team's namespace, for example
`team-platform`. kagent finds a Harness, ModelConfig, RemoteMCPServer, or EgressPolicy only
in the agent's own namespace, so the team base puts each one in every team namespace.
`kagent` holds only what the kagent install made. kagent is an alpha (1.0.0-alpha17), so
these shapes can change between releases. Each recipe says if this repo has run it or not.

## The four resources

| Resource | Says | Example |
|---|---|---|
| `Harness` | Which image runs, on which Substrate worker pool. | `coding` |
| `ModelConfig` | Which model, and where to reach it. | `executor-model-config` |
| `AgentTemplate` | The model, system prompt, MCP tools, and subagents. | `hello-agent` |
| `Agent` | One running agent: a template plus a harness, plus egress. | `hello-agent` |

A Harness is the "how it runs". A template is the "what it does". An Agent joins them.
So you can reuse one Harness for many agents.

## Recipe 1: an agent with no code (stock runtime)

**Tested:** yes (`triage-agent`; `make smoke` talks to it).

Use kagent's built-in runtime (`runtime: stock`, the team base's Harness `kagent-stock`).
You write a prompt and pick catalog tools and subagents by name:

```yaml
name: my-helper
team: platform
owner: your-github-handle
runtime: stock
model: glm-5.3-flash
systemPrompt: You are a concise helper. Reply briefly.
tools: [github-read]
subagents: [explorer]
```

Talk to it: `make chat TEAM=platform AGENT=my-helper MSG="hello"`.

Pick this when the agent only needs a prompt and MCP tools. It does not get our file tools,
`bash`, approvals on shell commands, or the implement loop.

**MCP tools work here with no code** (tested, see [ADR 0003](decisions/0003-a2a-and-stock-runtime.md)).
`triage-agent` reads an issue with `github-read` (`issue_read`). It needs no `EgressPolicy`
to reach in-cluster servers.

**Subagents work here too** (tested). The stock agent handed text to the subagent and
returned its reply.

## Recipe 2: a new agent on our image (coding runtime)

**Tested:** yes. `docs-agent` runs on the Harness `coding` next to `hello-agent`, each with
its own sessions (`deployments/platform/docs-agent/values.yaml`).

`runtime: coding` puts the agent on the team base's Harness `coding`, the image of `agent/`
that `make deploy` builds and pins by digest, with the `git-egress` and `npm-egress`
policies. You get every feature of `agent/`: file tools, `bash` with approvals, subagents,
extensions, `/implement`.

```yaml
name: docs-agent
team: platform
owner: your-github-handle
runtime: coding
model: glm-5.3-flash
systemPrompt: You fix documentation. Never change code files.
skills: [docs-style]
subagents: [explorer]
```

The agent adds its own rules (tools, verification, `ask_user`) to your `systemPrompt`, so
keep yours short.

## Recipe 3: reuse an existing MCP server (catalog tools)

**Tested:** yes, for our coding agent (`github-write` and `demo-delete-branch` on
`hello-agent`) and for the stock runtime (`github-read` on `triage-agent`).

A values file picks tools by catalog name. The catalog (`agent.catalog` in
`platform/charts/agent/templates/_helpers.tpl`) maps each name to a team base
`RemoteMCPServer`, its tools, and whether it writes:

| Catalog name | Server | Tools | Approval |
|---|---|---|---|
| `github-read` | `github-mcp` | `issue_read` | off; `{name: github-read, requireApproval: true}` turns it on |
| `github-write` | `github-mcp` | `create_branch`, `push_files`, `create_pull_request` | always on |
| `demo-delete-branch` | `demo-mcp` | `delete_branch` (a fake) | always on |

The chart renders each as a template binding:

```yaml
  tools:
    - mcp:
        server: {kind: RemoteMCPServer, name: github-mcp}
        tools: [create_branch, push_files, create_pull_request]
        requireApproval: true
```

- `tools` limits what the model sees. Leave out a tool and the model cannot call it.
- `requireApproval: true` pauses before every call (approve, deny, or approve for the
  session). The schema refuses `requireApproval: false` on a write tool.

## Recipe 4: add a new MCP server

**Tested:** yes (`demo-mcp`, `github-mcp`).

1. Run the server in its own namespace, with a Service. `platform/demo-mcp.yaml` is a small
   example.
2. Register it in the team base (`platform/charts/teams/templates/coding.yaml`), so every
   team namespace has it:

```yaml
apiVersion: api.kagent.dev/v1alpha3
kind: RemoteMCPServer
metadata: {name: my-mcp, namespace: team-platform}
spec:
  description: What it does
  protocol: STREAMABLE_HTTP
  url: http://my-mcp.my-mcp.svc.cluster.local:8080/mcp
```

3. Add a catalog name for it (Recipe 3) and to the schema's tool enum.

**If it needs a secret, take the header from a Secret with `headersFrom`.** Do what
`github-mcp` does: a Secret in each team namespace holds the full header value (for example
`Bearer <token>`), and the `RemoteMCPServer` names it:

```yaml
  headersFrom:
    - name: Authorization
      valueFrom: {type: Secret, name: my-mcp-token, key: token}
```

kagent puts only `__KAGENT_ENV[KAGENT_CREDENTIAL_<hash>]__` in the agent's config and a
placeholder in the actor's env. The agent sends the placeholder, and Substrate's egress
gateway swaps it for the Secret as the request leaves the actor. Never put a secret in a
plain `value` header: kagent copies those into the agent's config.

## Recipe 5: a new model

**Tested:** yes (the subagents' three ModelConfigs in the team base).

Route every model through agentgateway. Then the provider key stays in the gateway. The
`/v1` route takes only an agent key (the minter's, in ConfigMap
`agentgateway-system/agent-api-keys`): an agent's own ModelConfig names its Secret
`<agent>-agent-key` with `apiKeySecret`, as the values-file chart renders it. A subagent's
ModelConfig like this one needs no key: the coding agent's calls carry the parent agent's.

```yaml
apiVersion: api.kagent.dev/v1alpha3
kind: ModelConfig
metadata: {name: my-model-config, namespace: team-platform}
spec:
  provider: OpenAI
  model: glm-5.1
  openAI:
    apiFormat: chatCompletions
    baseUrl: http://agentgateway-proxy.agentgateway-system.svc.cluster.local/v1
```

A values file picks a model by platform name (`model:`); the chart renders the agent's own
ModelConfig `<agent>-model` for it. A model from another provider needs a new backend and route
in `platform/gateway.yaml` first.

## Recipe 6: a new subagent

**Tested:** yes, for our coding agent and for the stock runtime.

A values file picks subagents by name (`subagents: [explorer, executor, reviewer]`). Each is
a template in the team base (`explorer-template` and so on, with its own prompt and model);
the chart binds it:

```yaml
    - subAgent:
        name: explorer
        description: Read-only helper that finds and reads files and summarizes them. Cheap and fast.
        templateRef: {name: explorer-template}
```

A new subagent is a template in the team base, an entry in `agent.subagents`
(`platform/charts/agent/templates/_helpers.tpl`), and a name in the schema's enum. In our
coding agent the **name decides the tools**. `executor` gets all file tools. Any other name
gets only `read_file` and `search`. To give a new role other tools, change
`agent/src/subagents.ts`.

## Recipe 7: let an agent reach a new host

**Tested:** yes (`git-egress`, `npm-egress`).

An actor can reach almost nothing by default. An `EgressPolicy` in the team base opens hosts,
and the Agent lists it (the chart gives every coding agent `git-egress` and `npm-egress`):

```yaml
apiVersion: api.kagent.dev/v1alpha3
kind: EgressPolicy
metadata: {name: my-egress, namespace: team-platform}
spec:
  destinations:
    - origin: https://pypi.org
```

```yaml
  egressPolicyRefs: [{name: git-egress}, {name: npm-egress}, {name: my-egress}]
```

Open only the hosts the agent needs. Every open host is a place it can send data.

## Add tools in code instead

If YAML is not enough, write an extension: a `.ts` file in `agent/extensions/`. It can add a
tool, or watch, change, or block any tool call. See [extensions.md](extensions.md).

## Keep it in the repo

Agents live in `deployments/`; Argo CD deploys them. Platform objects go in the teams chart
(`platform/charts/teams/`), so `make up` recreates them. Pin any new image by digest in
`platform/versions.env` and `platform/images.lock` (see [pinned-versions.md](pinned-versions.md)).

## Recipe: bring your own image (byo runtime)

`runtime: byo` runs your image from a values file: set `image` to
`<allowed registry>/<path>@sha256:<64 hex>` (a tag or another registry is refused), and the
chart renders a Harness for it. Start from `templates/byo-ts`, build and push it with
`make byo-push DIR=templates/byo-ts NAME=my-agent`, and follow
[the byo contract](byo-contract.md).

## What a byo image must do itself

The full list of rules, with why kagent needs each, is [the byo contract](byo-contract.md).

kagent passes these to a `byo` image as config only. Nothing works until the image's code
handles it. Our `agent/` (the coding runtime's image) already does:

- **Subagents:** arrive in `agent.sub_agents`. The image must run them.
- **MCP tools:** arrive in `agent.http_tools` and `agent.sse_tools`. The image must connect.
- **Skills:** a template's `skills` (OCI image sources) arrive in `agent.agent_plugins.skills`,
  each with a read-only folder that kagent mounts. Our agent reads their `SKILL.md` files, and
  also `skills/` from the workspace. Git and S3 sources are refused. On a name clash the
  template skill wins and the agent logs `skill-clash`. `platform/deploy.sh` builds each skill
  in `platform/skills/` (`docs-style` on docs-agent) as a `FROM scratch` image pinned by
  digest, and every Application gets the pins.
- **Human-in-the-loop:** the image must send kagent's HITL pause and read the answer.

## Not supported yet on alpha17

- **One agent calling another agent over A2A.** kagent has not built this yet. A2A itself
  works for a user. The gaps: `AgentTemplate` has no agent-as-tool field (kagent comments
  out `agentRef` in `go/api/v1alpha3/agenttemplate_types.go` as "Deferred until Dedicated
  subagents can create and invoke their own Session"), and an agent's actor may not call
  `invoke_session` on another session. Have one agent tell the user which agent and command
  to run instead. Details and what to retest on a new kagent:
  [ADR 0003](decisions/0003-a2a-and-stock-runtime.md).
