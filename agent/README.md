# Agent

A TypeScript `byo` agent for kagent 1.x. Node 24 runs the source directly.

- `src/main.ts`: opens the gRPC port, answers `GET /readyz` on 8081, then imports the rest. `/readyz` is up before any heavy import.
- `src/server.ts`: A2A over gRPC (`@a2a-js/sdk`). Config comes from `KAGENT_CONFIG_JSON` (what kagent sets) or the file at `KAGENT_CONFIG_PATH`; the card from `KAGENT_AGENT_CARD_JSON`.
- `src/executor.ts`: an AI SDK `ToolLoopAgent` through the gateway (`@ai-sdk/openai-compatible`, base URL and model from the config), replied as an A2A Task with a `reply` artifact (the model's text) and, when files changed, a `diff` artifact (a unified diff of the turn). Files sent as raw parts with a file name are written to the workspace first. A turn ends after `AGENT_MAX_STEPS` model steps (default 25); the reply then says the step limit was reached. Calling `ask_user` pauses the task in `INPUT_REQUIRED` with an `ask_user_request` (kagent HITL extension, `src/hitl.ts`).
- `src/file-tools.ts`: `read_file`, `write_file`, `edit_file`, `search`, all through a `Sandbox`. `src/workspace-diff.ts` keeps each file's content before its first write in the turn and builds the diff.
- `src/sandbox.ts`: the `Sandbox` interface (`readFile`, `writeFile`, `exec`, `stop`) and the path check. `src/local-sandbox.ts` works on `$AGENT_DATA_DIR/workspaces/<contextId>/` with Node `fs` and `child_process`; `src/memory-sandbox.ts` (just-bash over a copy-on-write overlay, a dev dependency) is for tests, chosen with `AGENT_SANDBOX=memory`. Both refuse absolute paths, `..` out, and symlinks out.
- `src/session-state.ts`: the pending pause as JSON under `$AGENT_DATA_DIR/sessions/<contextId>/pending.json` (default `/data`, an actor snapshot keeps it), written temp-then-rename. A cold start reads it when the answer arrives.
- `src/controller-task-store.ts`, `src/wire.ts`: the task store. With `runtime.control_plane_url` in the config, tasks live in kagent's controller (`kagent.runtime.v1.TaskStoreService`), called with `Bearer placeholder` (Substrate swaps in the Actor JWT) and the session id from `/run/kagent/identity/name` (`KAGENT_IDENTITY_PATH`). Without it, the SDK's in-memory store.
- `src/cli.ts`: `pnpm --dir agent run cli -- "message"` (or `make chat MSG=...`) sends one message through the kagent controller, with the HITL extension header on every call. A pause prints the question and a `paused: task=... context=... request=...` line; answer it with `pnpm --dir agent run cli -- --task T --context C --request R "answer"`. `--file <path>` (repeatable; `make chat FILE=...`) attaches a file; the CLI prints the reply, then the diff. `AGENT`, `AGENT_NAMESPACE`, `KAGENT_URL` override the defaults.

```sh
pnpm --dir agent install --frozen-lockfile
pnpm --dir agent run typecheck
pnpm --dir agent test        # seam 1: the agent run with node, a fake config, a scripted model
```

Findings on kagent 1.0.0-alpha17 that shape the code:

- Deviation from the contract (`127.0.0.1:80`): the gRPC server binds all interfaces (`0.0.0.0:80`). Retested live with `KAGENT_GRPC_ADDR=127.0.0.1:80` set on the Harness: every message failed, and the atenet-router logged `grpc.status=14 error="upstream call failed: Connect: tunnel failed"` about 0.85 s after resume, while the agent's log showed `grpc-listening addr 127.0.0.1:80`. With `0.0.0.0:80` the same message returned `42`.
- The router dials the gRPC port as soon as `/readyz` answers, so the port is opened (by `src/early-listener.ts`, node:net only) before `/readyz` and holds connections until the real server is ready.
- kagent keeps its own record of every Task (`kagent.runtime.v1.TaskStoreService`). The call must go to `runtime.control_plane_url` with `Bearer placeholder`: the actor's egress policy swaps in an Actor JWT for that host only. Elsewhere the controller answers "runtime actor identity is required" (the S2 failure). Settle only real boundaries (terminal, or a move into a waiting state), or the controller refuses with "task changed". See `docs/decisions/0001-ts-or-go.md`.
- Subagent templates bound with `tools[].subAgent.templateRef` arrive in `KAGENT_CONFIG_JSON` under `agent.sub_agents`; the agent logs their names and key names at startup (`config-received`).
