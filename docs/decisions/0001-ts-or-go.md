# 0001: Stay on TypeScript for the byo agent

Status: accepted, 2026-10-22 (spike S3, kagent 1.0.0-alpha17, Substrate 0.6.0-alpha3).

## Context

The agent is a `byo` image in TypeScript (Node 24, `@a2a-js/sdk` over gRPC, AI SDK v6). The
spec says to move to Go (`kagent/go/adk/pkg/app`, `a2a-go`) if the spike shows the TypeScript
path cannot meet kagent's contract. Spike S2 met the gRPC and readiness contract but replied
with an A2A Message, because writing a Task to kagent's controller failed with
"runtime actor identity is required". Human-in-the-loop needs Tasks, so S3 had to settle
that first, then prove a pause that survives suspend and wake, and answer two more
questions: do subagent templates reach a `byo` image, and does the kagent UI show a pause.

## Evidence

### 1. The task store works from TypeScript

"runtime actor identity is required" is the controller's answer to a runtime call whose
`Authorization` header is not an Actor JWT. The Go ADK
(`go/adk/pkg/controllerclient/client.go`, `go/adk/pkg/taskstore/store.go`) shows the contract:

- call `kagent.runtime.v1.TaskStoreService` at `runtime.control_plane_url` from the config
  (here `http://kagent-controller.kagent.svc.cluster.local:8083`);
- send `authorization: Bearer placeholder`; the actor's egress policy has a rule for exactly
  that host and port that replaces the header with an Actor JWT
  (`ate-api-server` log, `GetActorEgressPolicy`: `kagent-controller.kagent.svc.cluster.local`,
  port 8083, `replace_headers ... actor_jwt`, audience `kagent-runtime`);
- take the session id from `/run/kagent/identity/name` (`session-<uuid>`, projected by
  Substrate and rebound on restore);
- create with no version, update with the version the controller returned, forward the
  gateway's `x-kagent-dispatch-id`, and call `SettleTask` after a real boundary.

`agent/src/controller-task-store.ts` does this in about 170 lines, with hand-written protobuf
codecs (`agent/src/wire.ts`) because kagent ships no TypeScript stubs; the A2A messages inside
reuse the codecs of `@a2a-js/sdk`. Two things the live cluster taught, and tests now cover:

- the SDK saves a waiting task unchanged when the user's reply arrives; settling that save is
  refused (`ABORTED: task changed or the session cannot accept this update`) and the whole turn
  fails, so only a move into a waiting state or a terminal state is settled;
- `requireSettledRuntime` blocks writes while an earlier boundary is unsettled, so settle
  right after the boundary save.

### 2. The HITL pause survives suspend and wake (live, kind)

Evidence is in `.scratch/s2-spike/verify/4-r1/` (not in git); every `kubectl` call used
`--context kind-build-coding-agent`.

| Step | What was seen |
|---|---|
| `make chat MSG="... red or blue? Ask me"` | CLI printed `question: Which colour should the button be?`, `choices: Red | Blue`, and `paused: task=61dfe6f7... context=01a1617b... request=d87171b1...` (task state INPUT_REQUIRED, `ask_user_request`) |
| 02:40:49 | atelet logged `Checkpoint timing` for `session-01a1617b-...`: the actor is suspended; the agent logged `task-saved state=6 version=23`, `task-settled version=23` |
| 20 s idle | no restore, no agent log lines |
| `cli -- --task ... --context ... --request ... Blue` at 02:41:17 | atelet logged `Restore timing` (02:41:18); the agent process started cold (`readyz-listening`, `heavy-imports-done` 0.6 s later); `turn pending=61dfe6f7... answered=yes`: the pause was read from `/data/sessions/<context>/pending.json` written before the suspend |
| reply | `Got it - the button will be **blue**. ...`; task state 3 (COMPLETED), `task-settled version=39`, then another `Checkpoint timing` |

Wake cost: restore 0.9 s plus the agent's cold start; the answer was accepted 0.1 s after
the gRPC port opened.

### 3. Subagent templates reach a `byo` image

`hello-agent`'s template binds `tools[].subAgent {name: explorer, templateRef: explorer-template}`.
The agent logs key names only. Live line (`config-received`):

```
agentKeys: description,instruction,model,session_db_url,stream,sub_agents
subAgents: [{"name":"explorer","keys":["description","instruction","model","name","stream"]}]
```

So kagent compiles the subagent into `KAGENT_CONFIG_JSON` under `agent.sub_agents`, with its own
instruction and model. The `byo` image gets the definition; it must implement the delegation
itself (nothing in kagent calls the subagent for a `byo` harness).

### 4. The kagent UI and the pause: yes, for the same user (S13 check)

Checked in a headless Chrome (playwright-core) against `svc/kagent-ui:8080`, with the CLI
making a session that ends in an open `ask_user` pause:

- **Same session: yes, but only for the same user.** Sessions belong to the `X-User-Id` of the
  caller. The CLI defaults to `cli@build-coding-agent`; with that id the UI's `hello-agent`
  page said "No conversations yet". With `KAGENT_USER_ID=admin@kagent.dev` (the user the UI
  signs in as) the same CLI turn is listed under CHATS on `/agents/kagent/hello-agent/new`.
- **The pause: yes.** Clicking that chat opens `/agents/<session>/chat`, which shows the user's
  message, "The agent asked you something and is waiting", the question "Which colour should
  the button be?", the choices red and blue, and "Send answer" / "Discard the question". So the
  UI renders the `ask_user_request` the agent sends. Answering from the UI was not tried.
- Steps: `KAGENT_USER_ID=admin@kagent.dev pnpm --dir agent run cli -- "Use the ask_user tool to
  ask me which colour the button should be, choices red or blue."`, port-forward `svc/kagent-ui`,
  open `/agents/kagent/hello-agent/new`, click the chat. Screenshots:
  `.scratch/s2-spike/verify/14-r2/ui-chats-list.png` and `ui-session.png`.

### 5. What Go would give for free

`go/adk/pkg/app` ships the task store with the settled-executor coordination (one active run
per session, abandoned-call handling), memory service, tracing, and generated stubs, so
proto drift between kagent alphas is caught at compile time. In TypeScript those are ours:
the wire codecs, and (not yet built) memory and tracing. The controller still enforces one
active run per session and the dispatch fence, so the missing in-process coordination has not
shown up as a failure.

## Decision

Stay on TypeScript. The gRPC contract (S2), Tasks through the controller, a HITL pause that
survives a real suspend and cold wake, and subagent config delivery all work on the TypeScript
path, and the course material (AI SDK v6) is TypeScript. Revisit and move to Go if one of these
happens: kagent changes `TaskStoreService` faster than `agent/src/wire.ts` can follow, we need
the memory service or kagent's tracing contract and the hand-written client grows past a
few hundred lines, or an alpha upgrade breaks settle semantics again.
