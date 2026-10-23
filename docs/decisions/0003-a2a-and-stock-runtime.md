# 0003: No agent-to-agent calls on alpha17; stock-runtime MCP tools and subagents work

Status: accepted, 2026-10-23 (spike #35, kagent 1.0.0-alpha17). Option A: A2A is deferred, not ruled out.

## Context

We wanted a triage agent on kagent's stock runtime (YAML only) that reads an issue with
`issue_read` and hands ready work to `hello-agent` over A2A. Most of that was never run on
alpha17, so the spike answered seven questions on the live kind cluster (2026-10-23). Every
`kubectl` call used `--context kind-build-coding-agent`.

## Evidence

### 1. Binding another Agent as a tool: not on alpha17

`kubectl explain agenttemplate.spec.tools` shows only `mcp` and `subAgent.templateRef`. There is
no field that refers to an Agent. The stock runtime has remote A2A tool code
(`go/adk/pkg/tools/remote_a2a_tool.go`, config key `remote_agents`), but no CRD field fills it,
so a byo image gets no `remote_agents` either.

The only other path is the `kagent-api` RemoteMCPServer tool `invoke_session` (plus
`list_sessions`). It works for a user and fails for an agent, by design:

| Caller | Result |
|---|---|
| User, `X-User-Id: cli@build-coding-agent`, `invoke_session` on a `stock-agent` session | `TASK_STATE_COMPLETED`, reply "ping" |
| Agent actor, plain `kagent-api` | `list_sessions` showed 0 sessions; `invoke_session` returned `Session not found` |
| Agent actor, RemoteMCPServer with `tokenPassthrough: true`, no caller token | `MCP token passthrough requires a caller bearer token` |
| Same, with a caller token | `Not authorized: actor is not authorized for get on Session` |

kagent's own test says the same: `TestMCPActorListsOnlyItsSession`
(`go/core/internal/mcp/auth_test.go` at v1.0.0-alpha17), an actor may list and invoke only its
own session.

### 2. `issue_read` on the stock runtime: works, YAML only

A stock agent with a `github-mcp` binding `tools: [issue_read]` returned issue #35's exact title.

### 3. Subagent `templateRef` on the stock runtime: works

The stock agent handed text to a subagent template and returned the subagent's "SUMMARY:" reply.

### 4. Two Agents on `hello-harness`: works

A `docs-agent` (the Recipe 2 YAML) edited a sent README and returned the diff. `list_sessions`
showed its session under `docs-agent`, apart from `hello-agent`'s. Each Agent has its own
actor and sessions.

### 5. When the called agent pauses

Through `invoke_session` the caller gets only `TASK_STATE_INPUT_REQUIRED` and the question text.
The HITL request id and the choices are only in the task: `GetTask` shows the `ask_user_request`
metadata. So:

- A plain-text `invoke_session` reply does not answer the pause. It starts a new task and
  pollutes the session history.
- Our CLI answering with `--task`, `--context`, `--request` on the called agent resumes the
  same task.
- The MCP tasks extension can also answer one, if the calling client supports it: `tasks/get`
  with `inputRequests`, `tasks/update` with `inputResponses` (kagent's
  `TestMCPAskUserContinuation`).

### 6. Ownership

A session belongs to the `X-User-Id` that created it. `list_sessions` as another user shows none
of them. An actor's own calls run as the actor, not as the human, so work an agent starts for
the human would not show in the human's UI list.

### 7. Egress

A stock agent with no `egressPolicyRefs` reached in-cluster MCP (`github-mcp`, `kagent-api`).
Calls to in-cluster services need no EgressPolicy.

## Decision

Option A: triage does not call other agents. It replies with the agent to use and the exact
command (for example `AGENT=hello-agent make chat MSG="/implement <issue URL>"`), and the user
runs it. This keeps every pause on the agent that owns it and builds nothing around kagent.

A2A is deferred, not ruled out. Retest when a new kagent lands:

- An agent reference in `AgentTemplate.spec.tools`, or anything else that fills `remote_agents`.
- Actor permission on `invoke_session` for another agent's session.
- Whether a pause crosses the hop with its HITL metadata (request id and choices), so the user
  can answer it.

## Consequences

- `docs/building-on-the-platform.md` lists MCP tools and subagents on the stock runtime as
  tested, and says A2A between agents does not work on alpha17.
- Stock-runtime agents are fine for read-only helpers (`issue_read`) and for routing advice.
