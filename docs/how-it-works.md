# How it works

## The pieces

```
you ── make chat ──> kagent controller ──> Substrate actor ──> agent (agent/)
                                                                  │
                         agentgateway <── model calls ────────────┤
                         (holds OPENCODE_KEY)                     │
                         GitHub MCP server <── branch/push/PR ────┤
                         (egress gateway adds the token)          │
                         github.com, npm <── git clone, installs ─┘
```

| Piece | What it is | Why it is here |
|---|---|---|
| **kind** | Kubernetes in Docker, on your machine. Context `kind-build-coding-agent`. | A real cluster with no cloud bill. |
| **kagent** (1.x) | Runs agents on Kubernetes. You describe an agent with `Harness`, `AgentTemplate` and `Agent` resources. Its controller takes your messages and keeps a record of every task. | It gives us sessions, a UI, MCP tool binding, subagent config, and human-in-the-loop for free. |
| **Agent Substrate** | Runs each session as an **actor**: a sandboxed process (gVisor) that is frozen to a snapshot when idle and restored on the next message. | Each session gets its own isolated machine. Idle sessions cost nothing. |
| **agentgateway** | A proxy in front of the model provider (the OpenCode Go plan). Holds the model key. | The agent and kagent never see the key. |
| **The agent** (`agent/`) | Our code. A Node 24 TypeScript program that kagent runs as a `byo` image. It speaks A2A over gRPC. | This is the part the course teaches us to build. |
| **GitHub MCP server** | GitHub's own MCP server, behind agentgateway's `/mcp/github`. The gateway's GitHub backend adds the token; the agent sends only its own key, and sees only its own tools. | The agent can push and open PRs without ever holding the token. |
| **Local registry** | `registry:2` on `localhost:5001`. | `make deploy` pushes the agent image here and names it by digest. |

## What happens when you send a message

1. `make chat` runs the CLI (`agent/src/cli.ts`). It sends your message to the kagent
   controller over A2A.
2. kagent finds or starts the session's actor. A cold actor is restored from its snapshot
   (about 1 s plus Node start-up).
3. The agent loads the session from `/data/sessions/<contextId>/state.json`. Nothing lives
   only in process memory, so a cold wake continues the conversation.
4. The agent builds the system prompt and the tools for this turn, then runs the model in a
   loop (AI SDK `ToolLoopAgent`). Each model call goes through agentgateway.
5. Each tool call runs in the session's workspace, `/data/workspaces/<contextId>/`.
6. A risky tool call pauses the task (`INPUT_REQUIRED`). The CLI prints the question and the
   ids you need to answer it. The actor can sleep while it waits.
7. At the end the agent replies with a `reply` artifact (text) and, when files changed, a
   `diff` artifact (a unified diff of this turn).

The agent saves the session after every model step. A crash or a suspend loses at most one step.

## The agent's tools

| Tool | What it does |
|---|---|
| `read_file`, `write_file`, `edit_file`, `search` | Work on files in the workspace. They refuse absolute paths, `..`, and symlinks that lead out. |
| `bash` | Runs a shell command in the workspace. Read-only commands (`ls`, `cat`, `grep`, `git status`, ...) run at once. Anything else pauses for your approval. 60 s timeout. |
| `ask_user` | Pauses and asks you a question, with choices when there are a few options. |
| `todo_write` | Keeps the turn's to-do list. |
| `load_skill` | Loads a skill's full text. Skills are `SKILL.md` files from the template's mounted skill images and from `skills/<name>/` in the workspace; the template wins a name clash. Only their names and descriptions are in the prompt. |
| `task` | Hands a job to a subagent (see below). |
| MCP tools | Tools from MCP servers bound on the `AgentTemplate`. Today: `create_branch`, `push_files`, `create_pull_request` (GitHub) and `delete_branch` (a demo that deletes nothing). Each call pauses for approval. |
| Extension tools | Tools added by modules in `agent/extensions/`. See [extensions.md](extensions.md). |

## Subagents

The `AgentTemplate` binds three subagent templates. kagent passes them to the agent in its
config. The agent runs them in the same process, on the same workspace.

| Name | Model | Tools | Used for |
|---|---|---|---|
| `explorer` | `glm-5.3-flash` (cheap) | `read_file`, `search` | Reading and planning. |
| `executor` | `glm-5.1` | all file tools | Writing code. |
| `reviewer` | `glm-5.1` | `read_file`, `search` | Code review in the implement loop. |

The role comes from the name: only `executor` can write. Subagents cannot call `task`, so
nesting is one level deep.

## Safety: what stops the agent doing harm

- **Approval gate.** Risky `bash` commands and every bound MCP tool pause until you approve.
  The tool checks the gate again when it runs, so an unapproved call never runs.
- **No credentials in the actor.** The provider key is in agentgateway. Each agent's own key
  (the minter's, Secret `<agent>-agent-key`) is added by Substrate's egress gateway as a model
  call leaves the actor; the gateway's `/v1` refuses a call without one. The same key goes, in
  header `x-agent-key`, on the agent's MCP calls to agentgateway's `/mcp/github` and
  `/mcp/demo`. The GitHub token is in Secret `github-mcp-token` in `agentgateway-system`, and
  only the gateway's GitHub backend sends it; no team namespace and no actor holds it. The
  agent's config and env hold a placeholder, and its logs hold neither.
- **Tool allow list at the gateway.** The minter writes one agentgateway policy per agent,
  `mcp-tools.<team>.<agent>`, that allows only the MCP tools of its catalog tools. Any other
  tool is missing from `tools/list` and answers `Unknown tool`, also to `curl` from `bash`.
- **Repo list at the gateway.** The same policy lets a GitHub write tool (`create_branch`,
  `push_files`, `create_pull_request`) run only on the repos in the agent's `github.repos`.
  The rule reads `owner` and `repo` from the `tools/call` body, because agentgateway
  v1.6.0 has no `mcp.tool.arguments` at authorization time
  (`docs/spike-mcp-authorization.md`). A call on another repo answers `Unknown tool`; an
  agent with no list changes no repo.
- **Narrow egress.** The actor can reach only `github.com`, `codeload.github.com` and
  `registry.npmjs.org` (the team base's `git-egress` and `npm-egress`). So `git clone` works
  for public repos only.
- **Extensions.** `protect-env` blocks file-tool writes to `.env` files. `redact-env` hides
  `.env` values from file-tool reads. They do not cover `bash`; the approval gate does.
- **Output caps.** Each tool result is cut to 20000 characters. Old tool results are pruned
  from what the model sees.

## Things kagent taught us

These are facts about kagent 1.0.0-alpha17 that shape the code. Do not "fix" them away.

- **Bind `0.0.0.0:80`, not `127.0.0.1:80`.** With loopback, every message failed with
  `upstream call failed: Connect: tunnel failed`.
- **Open the gRPC port before `/readyz`.** The router dials the port as soon as `/readyz`
  answers. `src/early-listener.ts` holds connections until the real server is ready.
- **Task store auth.** Calls to kagent's `TaskStoreService` must go to
  `runtime.control_plane_url` with `Bearer placeholder`. Substrate swaps in the actor's JWT for
  that host only. Anywhere else you get "runtime actor identity is required".
- **Settle only real boundaries.** Settle a task only when it ends or starts to wait.
  Otherwise the controller says "task changed".
- **Subagents arrive as config only.** kagent puts them in `agent.sub_agents`. A `byo` image
  must run them itself.
- **No stop signal in an actor.** A suspend freezes the process. So sandbox `beforeStop` hooks
  never fire on suspend.

Why TypeScript and not Go: [decisions/0001-ts-or-go.md](decisions/0001-ts-or-go.md).

## Prompt caching

The agent sends no cache markers. The provider caches repeated prompt prefixes by itself.
The `step-usage` log line shows `cachedTokens`.
