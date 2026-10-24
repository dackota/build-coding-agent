# The byo contract

A `runtime: byo` agent runs your image. kagent gives that image no SDK: it starts the image,
writes a config, and talks to it over the wire. Every rule below was learned the hard way in
this repo; each one says why kagent needs it. An image that breaks one fails in a way that
looks like something else (a hang, a refused connection, a task that never ends).

Start from the [TypeScript starter](../templates/byo-ts/README.md), which meets rules 1 to 6.
`agent/` in this repo is a worked example of all nine.

## How to deploy an image

Push the image to the allowed registry and pin it by digest in your values file. The schema
takes only `<allowed registry>/<path>@sha256:<64 hex>`; a tag or any other registry is
refused, so the image cannot change under a running agent. On kind the allowed registry is the
local one (`make byo-push DIR=templates/byo-ts NAME=my-agent` prints the line to paste).

```yaml
name: my-agent
team: platform
owner: your-github-handle
runtime: byo
image: 172.18.0.3:5000/my-agent@sha256:<64 hex>
command: ["node", "/app/src/main.ts"]
model: glm-5.3-flash
systemPrompt: You are a concise assistant.
```

`command` is what the Harness runs (kagent refuses a byo Harness without one); give the same one as the image's `ENTRYPOINT`. The key, token cap,
tool list and egress come from the values file like any other agent's.

## Check your image

```
make byo-push DIR=templates/byo-ts NAME=my-agent   # prints the image line
make byo-check IMAGE=<the address@sha256:digest from that line>
```

`make byo-check` runs your image as a pod in a throwaway namespace on the local kind cluster,
plays kagent's side (the task store, the model route, the config) from a checker pod, and
prints PASS, FAIL or skip for each rule below, then deletes the namespace. It exits non-zero
when a rule fails, and the FAIL line says what it saw. It checks rules 1 to 6. Rules 7 to 9
depend on your tools, approvals and the egress gateway, so it skips them; test those on a
deployed agent.

## Build in CI

`.github/workflows/build-byo-image.yml` is a reusable workflow: call it with `context` (the
folder with your Dockerfile) and `image` (the repository to push to), and it builds, pushes,
prints `image: <repository>@sha256:...` in the job summary, and outputs `digest` to later
jobs. The values schema accepts only the platform's allowed registry (the local one on kind),
so on kind use `make byo-push`.

## 1. A2A over gRPC

Serve the A2A protocol (v1) over gRPC, as a task-based server: a message starts a task, and
the task ends `COMPLETED`, `FAILED`, `CANCELED`, or waits in `INPUT_REQUIRED`.

**Why kagent needs it:** the controller's router and `make chat` speak A2A over gRPC to the
actor and nothing else; there is no HTTP or JSON fallback. Reply with a task, not a bare
message, because only a task has a record the controller can keep, publish and suspend on.

## 2. Bind 0.0.0.0:80

Listen for gRPC on all interfaces, port 80 (`KAGENT_PORT` overrides the port in tests).

**Why kagent needs it:** kagent's own text says `127.0.0.1:80`, but on alpha17 the router's
dial to that address is refused ("tunnel failed"). Only `0.0.0.0` is reached.

## 3. Open the port before /readyz

Serve `GET /readyz` on port 8081 returning 200, and open the gRPC port first. Keep the
imports that take time (the gRPC server, SDKs) after both are up; the starter's `main.ts`
holds early connections until the server is ready.

**Why kagent needs it:** Substrate marks the actor ready, and resumes it, when `/readyz`
answers, and the router dials the gRPC port at once. A wake is a cold start; a refused
connection in that window fails the user's message.

## 4. Task store calls to the control-plane URL with the placeholder bearer

Keep every task in kagent's controller, not in memory: call `TaskStoreService` (`createTask`,
`updateTask` with the version last returned, `getTask`, `listTasks`) at
`runtime.control_plane_url` from the config, with the header `authorization: Bearer
placeholder`, and the session id from the file `/run/kagent/identity/name` (`session-<uuid>`),
read on every call.

**Why kagent needs it:** the controller is the source of truth for the conversation, and the
actor is suspended between turns. Substrate replaces the placeholder with the actor's JWT as
the call leaves, so the image never holds a credential. The identity is rebound when an actor
is restored or forked, so a cached session id goes stale.

## 5. Settle only at real boundaries

Call `settleTask` once when a task reaches a boundary: a terminal state, or a move into
`INPUT_REQUIRED`. Never on progress saves, and not when a waiting task is saved again
unchanged because the user replied.

**Why kagent needs it:** settling is what lets the controller publish the result and let the
actor suspend. Settling too early ends the turn mid-way; settling a task that did not change is
refused ("task changed"), which fails the whole turn.

## 6. Read the runtime config

Read the config from `KAGENT_CONFIG_JSON`, or the file at `KAGENT_CONFIG_PATH` (default
`/config/config.json`): the model name and gateway base URL (`agent.model`), the system prompt
(`agent.instruction`), the control-plane URL (`runtime.control_plane_url`). Send the model call
to that base URL with `OPENAI_API_KEY` as the bearer; it holds only kagent's placeholder.

**Why kagent needs it:** the config is the only channel for what the platform decided: which
model, which gateway, which prompt. Substrate's egress gateway swaps the placeholder for the
agent's real key as the call leaves, so the image never reads, stores or logs a model key, and
the model route refuses a call without one.

## 7. Run subagents and MCP tools itself

If the values file lists `subagents` or `tools`, they arrive as config
(`agent.sub_agents`, `agent.http_tools`, `agent.sse_tools`, `agent.agent_plugins`). The image
connects to each MCP server and runs each subagent; show the model only the tools listed.

**Why kagent needs it:** kagent resolves them into config and does nothing more. It does not
proxy tool calls or start subagent loops for a byo image. A `tools` entry the image ignores
silently does nothing. The starter ignores them; `agent/src/mcp-tools.ts` and
`agent/src/subagents.ts` show how.

## 8. Send HITL pauses

To wait for a human (a question, or approval of a tool call marked `requireApproval`), finish
the turn in `INPUT_REQUIRED` with kagent's HITL message (`ask_user_request` or
`tool_approval_request`), keep what the turn needs to continue, and read the answer from the
next message. See `agent/src/hitl.ts`.

**Why kagent needs it:** the approval rule on a write tool is enforced by the image, not by
kagent. An image that runs the call without pausing breaks the rail the values file promised.
A pause also ends the turn, which is what lets the actor suspend while the human thinks, so
keep the pending pause on disk (`/data`), not in memory.

## 9. Honor the egress trust bundle

Trust the CA bundle Substrate projects into the actor, and do not pin certificates, bundle
your own CA list over it, or turn off verification. Reach only hosts the values file's egress
allows.

**Why kagent needs it:** an actor has no direct network. Its calls leave through Substrate's
egress gateway, which checks the origin against the allowed list, adds credentials (the model
key, the control-plane JWT, MCP headers), and re-signs TLS with the platform's CA. A client
that does not trust that bundle fails every outbound HTTPS call.
