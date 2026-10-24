# Glossary

The words this repo uses, and the words to avoid for each.

## Platform

**byo agent**:
An agent that runs an image the team brings ("bring your own") instead of kagent's built-in runtime: `runtime: byo` in a values file, with the image pinned by digest. It must follow [the byo contract](byo-contract.md); start from `templates/byo-ts`. The platform's own coding agent (`agent/`) is also a byo image of this kind.
_Avoid_: custom agent, BYO harness

**Harness**:
The kagent resource that says which image runs an agent and on which Substrate worker pool.
_Avoid_: runtime, deployment

**AgentTemplate**:
The kagent resource that holds an agent's model, system prompt, MCP tool bindings, and subagents.
_Avoid_: agent spec

**Actor**:
One session's sandboxed process on Agent Substrate. It is frozen to a snapshot when idle and restored on the next message.
_Avoid_: pod, container, worker

**Session**:
One conversation, named by its A2A `contextId`. Its state is `/data/sessions/<contextId>/state.json` and its files are `/data/workspaces/<contextId>/`.
_Avoid_: thread, chat

**Turn**:
One user message and the agent's work on it, up to a reply or a pause. One A2A task.
_Avoid_: run (that is an implement run), request

**Pause**:
A task in `INPUT_REQUIRED` that waits for the user: an `ask_user_request` (a question) or a `tool_approval_request` (approve, deny, or approve for the session).
_Avoid_: interrupt, prompt

**Workspace**:
The session's directory where every file tool and command runs. Tools refuse paths that lead out of it.
_Avoid_: repo, sandbox (the `Sandbox` is the interface that reaches it)

**Subagent**:
A second model loop the main agent starts with the `task` tool: `explorer` (reads), `executor` (writes), or `reviewer` (reads). It shares the workspace.
_Avoid_: child agent, worker

**Team**:
A group that ships agents, named on the team list `platform/teams.txt`. Its agents run in namespace `team-<team>` and deploy from `deployments/<team>/`.
_Avoid_: tenant, org

**Team base**:
The platform-owned objects in each team namespace that the team's agents resolve: WorkerPool and ServiceAccount `team-default`, `default-model-config`, Harness `kagent-stock`, Harness `coding` (pinned by `make deploy`), the subagent templates `explorer`, `executor` and `reviewer`, the catalog RemoteMCPServers, and the git and npm EgressPolicies. Teams cannot change it.
_Avoid_: team defaults, shared config

**Values file**:
One agent's `deployments/<team>/<agent>/values.yaml`, checked against the strict schema of `platform/charts/agent`. Its `runtime` field (`stock`, `coding`, `byo`) picks how the agent runs; the kagent object is still called the Harness.
_Avoid_: agent YAML, manifest

**Registration**:
The ConfigMap `<agent>-registration` the values-file chart renders next to the agent: team, agent, owner, model, and token cap, for the platform to read.
_Avoid_: agent record

**Token cap**:
A monthly limit on model tokens, enforced at agentgateway through Envoy's `ratelimit` service and Redis. Each call is checked against two caps: the agent's (`tokenCap` in its values file) and its team's (the **team budget** in `platform/budgets.txt`, which no team can edit). Over either, the call gets HTTP 429. The minter writes both into the ratelimit config; a team with no budget gets no keys. `make status` prints use against each cap. The window is the service's month, 30 days.
_Avoid_: quota, spend limit

**Minter**:
The platform's CronJob in `platform-system` (`agent/src/minter/`) that runs every minute, reads the registrations of every listed team, and gives each agent its own agent key and token cap; it removes the key and cap of an agent whose registration is gone. Its pure core is `plan()`.
_Avoid_: key operator, provisioner

**Agent key**:
One agent's random model key: the key in Secret `<agent>-agent-key` in its team namespace, which its ModelConfig `<agent>-model` names, and the key's hash with `team` and `agent` metadata in agentgateway's ConfigMap `agent-api-keys`. The model route takes no other key. The actor holds only kagent's placeholder.
_Avoid_: API token, team key

## Extensibility

**Extension**:
A TypeScript module in the agent image's extension directory whose default export registers custom tools and lifecycle event handlers at startup.
_Avoid_: plugin, hook module, add-on

**Built-in tool**:
A tool the agent itself provides (`read_file`, `write_file`, `edit_file`, `search`, `bash`, `ask_user`, `todo_write`, `load_skill` on turns whose workspace has skills, `task` when the config has subagents), registered before any extension loads. Its name is reserved on every turn, whether or not the tool exists that turn. An MCP tool (from a binding in the kagent config) is not a built-in tool.
_Avoid_: core tool, native tool

**Custom tool**:
A tool registered by an extension; the model calls it like a built-in tool, and it may compose built-in tools.
_Avoid_: plugin tool, user tool

**Tool registry**:
The ordered set of named tool factories a turn's tools are built from: the turn's MCP tools, then the built-in tools, then the custom tools. The subagents' tools come from the same built set.
_Avoid_: toolbox, tool map

**Lifecycle event**:
A named point in a tool call (`tool_call` before it runs, `tool_result` after) where extension handlers can watch, block, or change it.
_Avoid_: hook (the `Sandbox` lifecycle hooks `afterStart`, `beforeStop`, `onTimeout` are a different thing), callback, middleware

**Block**:
A `tool_call` handler's refusal of one call, with a reason the model gets as the tool result; the tool does not run.
_Avoid_: deny (that is a user's approval answer), veto

**Modify**:
A handler's replacement of a tool call's input (`tool_call`, checked again against the tool's input schema) or of its output (`tool_result`); later handlers, the tool, and the model see the replacement.
_Avoid_: rewrite, patch, transform

## Implement loop

**Implement run**:
One `/implement <issue URL>` from start to a pull request or a park. One run is one issue and one pull request; a session has at most one open run. The agent's code reads the command, not the model.
_Avoid_: job, task (an A2A task is one turn)

**Step machine**:
The pure function `next(state, event)` in `agent/src/loop.ts` that gives the run's new state and the one action to do next. It does no I/O; a runner does each action and sends the result back as an event.
_Avoid_: workflow engine, state graph

**Start approval**:
The pause before a run builds anything: a `tool_approval_request` that names the exact setup command, the exact test command, the branch, and the repo the pull request goes to. After it, the loop runs those two commands and calls the GitHub MCP server's branch, push and pull request tools with no second approval.
_Avoid_: confirmation, consent prompt

**Loop command**:
The approved setup or test command, run by loop code through the `Sandbox` with the loop's own timeout (default 300 s), not through the model's `bash` (60 s).
_Avoid_: step command

**Park**:
The run stops before a pull request, tells the user why and shows the last test output, and keeps the workspace and the loop state. `/implement continue [note]` gives a run parked in the build 3 more rounds; `/implement stop` drops it.
_Avoid_: fail, abort

**Round**:
One pass of the test-first build and check, counted once for the whole run. The cap is 3; `continue` adds 3. A tests step that writes a non-test file, tests that pass before any code, and red tests after the code each end a round.
_Avoid_: iteration, attempt
