# Agent

The coding agent. A TypeScript `byo` image for kagent 1.x. Node 24 runs the `.ts` source
directly (no build step).

How the pieces fit: [../docs/how-it-works.md](../docs/how-it-works.md).

## Develop

```sh
pnpm --dir agent install --frozen-lockfile
pnpm --dir agent run typecheck
pnpm --dir agent test          # no cluster needed: fake config, scripted model
make deploy                    # run your change on the cluster
```

Tests run the real agent with Node against a fake kagent controller, a fake MCP server, and a
scripted model. `AGENT_SANDBOX=memory` swaps the workspace for an in-memory one.

## Code map

Start-up and transport:

| File | Job |
|---|---|
| `src/main.ts` | Entry point. Opens the gRPC port and `/readyz` first, then loads the rest. |
| `src/early-listener.ts`, `src/readyz.ts` | Hold connections and answer `/readyz` before the heavy imports finish. |
| `src/server.ts` | A2A over gRPC. Reads config and env, builds the executor. |
| `src/config.ts` | Parses kagent's config (`KAGENT_CONFIG_JSON`). |
| `src/controller-task-store.ts`, `src/wire.ts` | Saves tasks to kagent's controller. Hand-written protobuf codecs. |
| `src/hitl.ts` | kagent's human-in-the-loop extension: the pause and the answer. |

One turn:

| File | Job |
|---|---|
| `src/executor.ts` | Runs one turn: load session, build prompt and tools, run the model, reply. |
| `src/system-prompt.ts` | Builds the system prompt: instruction, tool list, rules, the workspace's `AGENTS.md`. |
| `src/session-state.ts` | The session as one JSON file. Saved after every step, crash-safe. |
| `src/context.ts` | Output cap and pruning of old tool results. |
| `src/gateway.ts` | The model client, through agentgateway. |
| `src/stream-events.ts` | Progress events the CLI prints while a turn runs. |
| `src/approval.ts` | The tool approval pause and its three answers. |

Tools:

| File | Job |
|---|---|
| `src/tool-registry.ts` | Builds each turn's tools in a fixed order and wraps them with extension events. |
| `src/file-tools.ts` | `read_file`, `write_file`, `edit_file`, `search`. |
| `src/workspace-diff.ts` | Remembers each file before its first write and builds the turn's diff. |
| `src/shell-tool.ts` | `bash` and its read-only allow list. |
| `src/mcp-tools.ts` | Tools from bound MCP servers. New clients each turn. |
| `src/todo-tool.ts` | `todo_write`. |
| `src/skills.ts` | Finds `skills/*/SKILL.md` and serves `load_skill`. |
| `src/subagents.ts` | The `task` tool and the in-process subagents. |
| `src/extensions.ts` | Loads `extensions/*.ts`. See [../docs/extensions.md](../docs/extensions.md). |

Workspace:

| File | Job |
|---|---|
| `src/sandbox.ts` | The `Sandbox` interface (`readFile`, `writeFile`, `exec`, `stop`), path checks, lifecycle hooks. |
| `src/local-sandbox.ts` | The real one: `$AGENT_DATA_DIR/workspaces/<contextId>/` with Node `fs` and `child_process`. |
| `src/memory-sandbox.ts` | An in-memory one for tests (just-bash). |

Implement loop: `src/loop*.ts`. See [../docs/implement-loop.md](../docs/implement-loop.md).

CLI: `src/cli.ts` and `src/a2a-client.ts`. See [../docs/using-the-agent.md](../docs/using-the-agent.md).

Other: `src/log.ts` writes one JSON line per event. Never pass it config, env, or request bodies.

## Settings

Set these on the Harness (`platform/agent.yaml.tmpl`, `spec.workload`) or in tests.

| Variable | Default | What it sets |
|---|---|---|
| `AGENT_MAX_STEPS` | `25` | Model steps per turn. At the limit the reply says so. |
| `AGENT_MAX_TOOL_OUTPUT_CHARS` | `20000` | Cap on each tool result. A cut result ends with `[truncated]`. |
| `AGENT_LOOP_TIMEOUT_MS` | `300000` | Timeout for the implement loop's setup and test commands. (`bash` is fixed at 60 s.) |
| `AGENT_GIT_BASE_URL` | `https://github.com` | Where the implement loop clones from. |
| `AGENT_DATA_DIR` | `/data` | Sessions and workspaces. The actor snapshot keeps it. |
| `AGENT_EXTENSIONS_DIR` | `extensions/` beside `src/` (`/app/extensions` in the image) | Where extensions load from. |
| `AGENT_SANDBOX` | `local` | `memory` for tests. |
| `KAGENT_GRPC_ADDR` | `0.0.0.0:${KAGENT_PORT:-80}` | gRPC bind address. Keep `0.0.0.0`. |
| `KAGENT_READYZ_PORT` | `8081` | `/readyz` port. |

kagent sets `KAGENT_CONFIG_JSON` and `KAGENT_AGENT_CARD_JSON`. Outside kagent, point
`KAGENT_CONFIG_PATH` at a config file instead.

## The image

`Dockerfile` builds on the pinned `node:24-slim`. It has `git`, `node`, and `pnpm` (the
`packageManager` version in `package.json`). `make deploy` builds it, pushes it to the local
registry, and runs it by digest.
