# Agent

A TypeScript `byo` agent for kagent 1.x. Node 24 runs the source directly.

- `src/main.ts`: opens the gRPC port, answers `GET /readyz` on 8081, then imports the rest. `/readyz` is up before any heavy import.
- `src/server.ts`: A2A over gRPC (`@a2a-js/sdk`). Config comes from `KAGENT_CONFIG_JSON` (what kagent sets) or the file at `KAGENT_CONFIG_PATH`; the card from `KAGENT_AGENT_CARD_JSON`.
- `src/executor.ts`: one model call through the gateway (`@ai-sdk/openai-compatible`, base URL and model from the config), replied as an A2A Message. The agent holds no model key.
- `src/cli.ts`: `pnpm --dir agent run cli -- "message"` (or `make chat MSG=...`) sends one message through the kagent controller. `AGENT`, `AGENT_NAMESPACE`, `KAGENT_URL` override the defaults.

```sh
pnpm --dir agent install --frozen-lockfile
pnpm --dir agent run typecheck
pnpm --dir agent test        # seam 1: the agent run with node, a fake config, a scripted model
```

Findings on kagent 1.0.0-alpha17 that shape the code:

- Deviation from the contract (`127.0.0.1:80`): the gRPC server binds all interfaces (`0.0.0.0:80`). Retested live with `KAGENT_GRPC_ADDR=127.0.0.1:80` set on the Harness: every message failed, and the atenet-router logged `grpc.status=14 error="upstream call failed: Connect: tunnel failed"` about 0.85 s after resume, while the agent's log showed `grpc-listening addr 127.0.0.1:80`. With `0.0.0.0:80` the same message returned `42`.
- The router dials the gRPC port as soon as `/readyz` answers, so the port is opened (by `src/early-listener.ts`, node:net only) before `/readyz` and holds connections until the real server is ready.
- kagent keeps its own record of every Task (`kagent.runtime.v1.TaskStoreService`) and answers `task not found` unless the agent writes it there; that call needs an actor identity the agent does not have (`runtime actor identity is required`). So the agent replies with a Message. Tasks (HITL pauses, long runs) need that identity solved first.
