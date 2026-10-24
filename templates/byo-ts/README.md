# byo TypeScript starter

A minimal `runtime: byo` agent: it answers a message with the model's reply. It was cut
down from the platform's coding agent (`agent/`). It meets rules 1 to 6 of
[the byo contract](../../docs/byo-contract.md). It has no tools, subagents or pauses
(rules 7 and 8, with `agent/src` as the worked example), and keeps the conversation in
memory.

| File | Rule |
| --- | --- |
| `src/main.ts`, `src/early-listener.ts`, `src/readyz.ts` | 2, 3: bind 0.0.0.0:80, port before `/readyz` |
| `src/server.ts` | 1: A2A over gRPC |
| `src/task-store.ts`, `src/wire.ts` | 4, 5: the controller's task store, settle at boundaries |
| `src/config.ts`, `src/model.ts` | 6: runtime config, the placeholder key |

## Mirrored files

The starter must build on its own, so these files are copies of files in `agent/src`:
`early-listener.ts`, `readyz.ts`, `log.ts`, `wire.ts`, and `task-store.ts` (from
`controller-task-store.ts`). `model.ts` is a near copy of `gateway.ts`. Change both
sides together. `agent/test/byo-starter-mirror.test.ts` fails when a copy drifts.

## Deploy

```
make byo-push DIR=templates/byo-ts NAME=my-agent   # builds, pushes, prints the image line
```

Prove it meets the contract first: `make byo-check IMAGE=<the address@sha256 digest it printed>`.

Copy `values.example.yaml` to `deployments/<team>/<name>/values.yaml`, paste the image line,
and open a pull request; Argo CD deploys it. Then `make chat TEAM=<team> AGENT=<name> MSG=hi`.

Check types with `pnpm install && pnpm run typecheck` in this folder.
