# Building on the platform

How to add your own agents, tools, and models to the cluster `make up` builds. Each recipe
is a YAML change you apply with `kubectl --context kind-build-coding-agent apply -f <file>`.

All resources here are `api.kagent.dev/v1alpha3` in namespace `kagent`. kagent is an alpha
(1.0.0-alpha17), so these shapes can change between releases. Each recipe says if this
repo has run it or not.

## The four resources

| Resource | Says | Example |
|---|---|---|
| `Harness` | Which image runs, on which Substrate worker pool. | `hello-harness` |
| `ModelConfig` | Which model, and where to reach it. | `executor-model-config` |
| `AgentTemplate` | The model, system prompt, MCP tools, and subagents. | `hello-agent` |
| `Agent` | One running agent: a template plus a harness, plus egress. | `hello-agent` |

A Harness is the "how it runs". A template is the "what it does". An Agent joins them.
So you can reuse one Harness for many agents.

## Recipe 1: an agent with no code (stock runtime)

**Tested:** yes (`make smoke` uses it).

Use kagent's built-in runtime. You write only YAML. Copy `platform/stock-agent.yaml`:

```yaml
apiVersion: api.kagent.dev/v1alpha3
kind: AgentTemplate
metadata: {name: my-helper, namespace: kagent}
spec:
  description: Answers questions about our runbooks
  modelConfig: {name: default-model-config}
  systemPrompt: You are a concise helper. Reply briefly.
---
apiVersion: api.kagent.dev/v1alpha3
kind: Agent
metadata: {name: my-helper, namespace: kagent}
spec:
  template: {ref: {name: my-helper}}
  harnessRef: {name: kagent-stock}
```

Talk to it: `AGENT=my-helper make chat MSG="hello"`.

Pick this when the agent only needs a prompt and MCP tools. It does not get our file tools,
`bash`, approvals on shell commands, or the implement loop.

## Recipe 2: a new agent on our image

**Tested:** no. We have run only one Agent on `hello-harness`.

Reuse `hello-harness` with a new template. You get every feature of `agent/`: file tools,
`bash` with approvals, subagents, extensions, `/implement`.

```yaml
apiVersion: api.kagent.dev/v1alpha3
kind: AgentTemplate
metadata: {name: docs-agent, namespace: kagent}
spec:
  description: Fixes docs only
  modelConfig: {name: default-model-config}
  systemPrompt: You fix documentation. Never change code files.
  tools:
    - subAgent:
        name: explorer
        description: Read-only helper that finds and reads files.
        templateRef: {name: explorer-template}
---
apiVersion: api.kagent.dev/v1alpha3
kind: Agent
metadata: {name: docs-agent, namespace: kagent}
spec:
  template: {ref: {name: docs-agent}}
  harnessRef: {name: hello-harness}
  egressPolicyRefs: [{name: agent-git-egress}]
```

Apply it after `make deploy` (which creates `hello-harness`). The agent adds its own rules
(tools, verification, `ask_user`) to your `systemPrompt`, so keep yours short.

## Recipe 3: reuse an existing MCP server

**Tested:** yes, for our byo agent (`github-mcp` and `demo-mcp` on `hello-agent`).

A `RemoteMCPServer` is defined once. Any template can bind it. List only the tools the
agent needs:

```yaml
  tools:
    - mcp:
        server: {kind: RemoteMCPServer, name: github-mcp}
        tools: [create_branch, push_files, create_pull_request]
        requireApproval: true
```

- `tools` limits what the model sees. Leave out a tool and the model cannot call it.
- `requireApproval: true` pauses before every call (approve, deny, or approve for the session).
- Servers on the cluster now: `github-mcp` (`issue_read`, `create_branch`, `push_files`,
  `create_pull_request`) and `demo-mcp` (`delete_branch`, a fake).

## Recipe 4: add a new MCP server

**Tested:** yes (`demo-mcp`, `github-mcp`).

1. Run the server in its own namespace, with a Service. `platform/demo-mcp.yaml` is a small
   example.
2. Register it:

```yaml
apiVersion: api.kagent.dev/v1alpha3
kind: RemoteMCPServer
metadata: {name: my-mcp, namespace: kagent}
spec:
  description: What it does
  protocol: STREAMABLE_HTTP
  url: http://my-mcp.my-mcp.svc.cluster.local:8080/mcp
```

3. Bind it on a template (Recipe 3).

**If it needs a secret, do not put it in `RemoteMCPServer` headers.** kagent copies headers
into the agent's config, so the agent would hold the secret. Do what `github-mcp.yaml` does:
put a small proxy in the server's pod that adds the secret from a Secret. The
`RemoteMCPServer` points at the proxy and has no headers.

## Recipe 5: a new model

**Tested:** yes (three ModelConfigs in `agent.yaml.tmpl`).

Route every model through agentgateway. Then the key stays in the gateway.

```yaml
apiVersion: api.kagent.dev/v1alpha3
kind: ModelConfig
metadata: {name: my-model-config, namespace: kagent}
spec:
  provider: OpenAI
  model: glm-5.1
  openAI:
    apiFormat: chatCompletions
    baseUrl: http://agentgateway-proxy.agentgateway-system.svc.cluster.local/v1
```

Use it with `modelConfig: {name: my-model-config}` on a template. A model from another
provider needs a new backend and route in `platform/gateway.yaml` first.

## Recipe 6: a new subagent

**Tested:** yes, for our byo agent.

Write a template for it (its own prompt and model), then bind it:

```yaml
    - subAgent:
        name: tester
        description: Runs nothing; reads tests and says what is missing.
        templateRef: {name: tester-template}
```

In our byo agent the **name decides the tools**. `executor` gets all file tools. Any other
name gets only `read_file` and `search`. To give a new role other tools, change
`agent/src/subagents.ts`.

## Recipe 7: let an agent reach a new host

**Tested:** yes (`agent-git-egress`).

An actor can reach almost nothing by default. Add an `EgressPolicy` and list it on the Agent:

```yaml
apiVersion: api.kagent.dev/v1alpha3
kind: EgressPolicy
metadata: {name: my-egress, namespace: kagent}
spec:
  destinations:
    - origin: https://pypi.org
```

```yaml
  egressPolicyRefs: [{name: agent-git-egress}, {name: my-egress}]
```

Open only the hosts the agent needs. Every open host is a place it can send data.

## Add tools in code instead

If YAML is not enough, write an extension: a `.ts` file in `agent/extensions/`. It can add a
tool, or watch, change, or block any tool call. See [extensions.md](extensions.md).

## Keep it in the repo

Put new resources in a file under `platform/` and apply it from `platform/deploy.sh`, so
`make deploy` recreates it. Pin any new image by digest in `platform/versions.env` and
`platform/images.lock` (see [pinned-versions.md](pinned-versions.md)).

## What a byo image must do itself

kagent passes these to a `byo` image as config only. Nothing works until the image's code
handles it. Our `agent/` already does:

- **Subagents:** arrive in `agent.sub_agents`. The image must run them.
- **MCP tools:** arrive in `agent.http_tools` and `agent.sse_tools`. The image must connect.
- **Skills:** kagent does not pass them at all. Our agent reads `skills/` from the workspace.
- **Human-in-the-loop:** the image must send kagent's HITL pause and read the answer.

## Not tried here

- One agent calling another agent over A2A.
- MCP tools and subagents on the stock runtime.

For these, read the [kagent docs](https://kagent.dev/docs) and test on the cluster first.
