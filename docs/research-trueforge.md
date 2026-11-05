# Research: TrueForge as a harness next to kagent

What TrueForge is, what it gives compared with kagent and our `agent/`, and whether it can run
as a kagent `byo` image. Read from source on 2026-11-04; nothing was installed or run.

## Answer

- **TrueForge is an agent loop with a server around it, not a control plane.** It is a
  TypeScript monorepo (MIT, TrueFoundry, Node >= 22.14): a library (`trueforge-core`) that runs
  the loop, a Hono HTTP server with SQLite or Postgres, a generated TS SDK, a chat UI and a UI
  SDK. Latest is 0.183.1 (2026-11-04). It is four months old and pre-1.0. The core package
  says it has no compatibility guarantees.
- **It does not speak A2A.** Its only protocol is REST plus SSE (`/api/v1/sessions/{id}/turns`).
  So it fails byo rules 1 to 6 as shipped, and every one of them needs an adapter.
- **kagent and TrueForge mostly sit at different layers.** kagent runs agents on Kubernetes:
  CRDs, the controller task store, Substrate actors, egress and credential injection, the UI,
  and scheduled runs. TrueForge is a harness: the loop, context handling, tool policy, pauses.
  They overlap on the loop features of kagent's stock runtime (MCP, HITL, skills, compaction,
  memory) and on sessions, UI and schedules. TrueForge adds four things neither kagent nor our
  agent has: deferred tool loading, offloading large results to a file, Code Mode, and
  parallel dynamic subagents.
- **Fit verdict: works with an adapter for an MCP-only agent; poor fit as our coding agent
  today.** The protocol adapter is medium-sized (about 1,000 new TypeScript lines; it reuses
  our A2A server, task store and HITL code). The blocker is the sandbox. TrueForge's only code
  tool is `exec` inside a sandbox. In this version the sandbox is Daytona (an outside SaaS) or,
  in standalone mode only, a local bubblewrap sandbox that has not been tried inside gVisor.
- **Recommended shape: (c), borrow techniques into `agent/`.** The four techniques above are
  small, readable and MIT-licensed. Use shape (a), the TrueForge server behind a thin
  A2A-gRPC adapter, only if a team wants TrueForge itself, with the sandbox switched off.
  Avoid (b), embedding `trueforge-core` as a library: the core has no compatibility
  guarantees, pulls in AI SDK 7 and zod 4 next to our AI SDK 6 and zod 3, and needs a 24-method
  store written by us.
- **Top risks:** churn (a minor release about every two to five days); the SSRF guard blocks
  agentgateway's in-cluster URL until it is allow-listed; MCP tools with no annotations are not
  gated by the default approval rule; `exec` has no approval gate; the in-process controller
  (schedules, memory ingest) does not run while the actor is suspended.

## Sources

- **TF:** github.com/truefoundry/trueforge at tag `@truefoundry/trueforge@0.183.1`, commit
  `d01160a9e218a04a6c1fc6d4a02801c1569a2b11`. A path `TF <path>:<line>` means
  `https://github.com/truefoundry/trueforge/blob/d01160a9e218a04a6c1fc6d4a02801c1569a2b11/<path>#L<line>`.
  The trueforge.dev pages are built from `TF docs/` (Mintlify, `TF docs/docs.json`); each
  `docs/x.mdx` is `https://trueforge.dev/x`.
- **KA:** github.com/kagent-dev/kagent at tag `v1.0.0-alpha17` (the pinned version, commit
  `8392184232e9c78196433a34b1fd3b33db5fcb97`). Paths marked *rc2* were also checked at
  `v1.0.0-rc2` (commit `4a5c758598a983c47ea14ea1757b191db8423884`).
- **Repo:** paths in this repo, at commit `2e31364`.
- Repository facts from `gh repo view` and `gh release list` on 2026-11-04: created
  2026-07-23, 6,439 stars, 554 forks, 48 contributors, 108 open issues.

## 1. What TrueForge is

### Packages

| Package | What it is | Source |
|---|---|---|
| `@truefoundry/trueforge-core` | The loop as a library: sessions, turns, the model client, MCP, sandbox, capabilities. "Not a complete product on its own." No compatibility guarantees; pin an exact version. | `TF packages/trueforge-core/README.md`, `package.json` |
| `@truefoundry/trueforge` | The server: Hono HTTP API, SQLite or Postgres stores, catalogs, auth, schedules, bundled UI. The `npx` entry. | `TF packages/trueforge/package.json`, `src/main.ts` |
| `@truefoundry/trueforge-sdk` | A TS client generated from the OpenAPI spec (Fern). A Python SDK too. | `TF AGENTS.md`, `python/` |
| `@truefoundry/trueforge-ui`, `assistant-ui-runtime`, `frontend` | Embeddable chat UI and the bundled app. | `TF README.md` |

Runtime: Node >= 22.14 (`TF package.json` `engines`; `.nvmrc` is 22.23.2). The image is
`node:24-slim` (`TF Dockerfile:21-22`). Core depends on `ai` ^7, `zod` ^4,
`@modelcontextprotocol/sdk`, `@daytona/sdk` (`TF packages/trueforge-core/package.json:116-124`).

### Releases and maturity

- First stable server release 0.1.0 on 2026-08-16; 0.183.1 on 2026-11-04. The version jumped
  from 0.3.1 to 0.177.0 on 2026-10-07. Since then a minor or patch lands every two to five
  days, each with `-rc` pre-releases for all five packages (`gh release list`).
- Changesets may only be `patch`; minors come from "an external release process"
  (`TF AGENTS.md`).
- **Claim, TrueFoundry's own benchmark:** about 30% cheaper than Claude Managed Agents on the
  same model, about 2.5x cheaper than deepagents, about 75% cheaper on GLM-5.2, "same accuracy",
  on 14 tasks (`TF docs/benchmarking.mdx:7-11`). Not checked by us.

### Architecture

- **Two modes.** Local: one process, SQLite, no login, "keep it on localhost"
  (`TF README.md:80`). Hosted: Postgres plus Redis, Docker Compose, Helm (`TF charts/trueforge`)
  or Railway. `STANDALONE=true` is the default (`TF packages/trueforge/src/main.ts:6`).
- **Server.** HTTP on port 8790, host `localhost` by default (`TF packages/trueforge/src/config.ts:26-28`);
  the image sets `HOST=0.0.0.0` (`TF Dockerfile:112`). `GET /healthz`
  (`TF packages/trueforge/src/app.ts:391`). Service routes take a bearer API key
  (`TF packages/trueforge/src/auth/middleware.ts:73-76`); OIDC is optional.
- **Model of work.** Agent → sessions → turns → events → deltas. A turn is one user message or
  one approval reply. Turns chain by `previous_turn_id` (default `auto`), so the server keeps
  the history (`TF docs/api/overview.mdx:89`). One turn runs per session at a time.
- **HTTP API.** `POST /api/v1/sessions`, `POST /api/v1/sessions/{id}/turns` (SSE stream by
  default), `GET .../turns/{turn_id}`, `.../events`, `.../subscribe` (resume a stream by
  sequence number), `POST /api/v1/sessions/{id}/cancel`; settings under `/api/v1/settings`
  (model providers, MCP servers, sandbox providers) (`TF packages/trueforge/src/routes/turnRoutes.ts`,
  `sessionRoutes.ts`, `app.ts:540-620`).
- **The loop as a library.** `Sessions` over an `ISessionStore`, then
  `SessionHandle.createTurn({ resolver, ... })` and `TurnHandle.stream()`
  (`TF packages/trueforge-core/src/agent-session/Sessions.ts`, `SessionHandle.ts:179-195`).
  The host supplies an `ITurnResourceResolver`: model client, MCP connections, sandbox, agent
  spec, tracing (`TF .../agent-session/ITurnResourceResolver.ts`). A ready base class takes
  callbacks for each (`TF .../agent-session/TurnResourceResolver.ts`). Core exports only an
  in-memory store; the SQLite and Postgres stores live in the server package. The store
  contract has 24 methods (`TF .../agent-session/store/ISessionStore.ts:279-442`). So the loop
  is usable as a library, but persistence is yours to write.
- **Agent spec.** `model` (`provider/model`), `instructions`, `mcp_servers` (by configured name,
  with `enable_tools`, `disable_tools`, `preload_tools`, `require_approval_for_tools`),
  `skills`, `response_format`, and `config`: `iteration_limit` (default 512), sandbox,
  dynamic subagents, compaction, large tool responses, Generative UI, ask-user, web search
  (`TF packages/trueforge-core/src/agent-session/schemas/agentSpec.ts`). MCP auth headers are
  not in the spec; they come from the configured server record.

### Features, with where they live

| Feature | How it works | Source |
|---|---|---|
| Model providers | OpenAI (Responses API), Anthropic, Gemini, Moonshot, Alibaba, and OpenAI-compatible: Fireworks, Z AI, Together, `custom`, `truefoundry`. Each takes a base URL, key and headers. | `TF packages/trueforge-core/src/core/llm/VercelAILLM.ts:59-70, 133-150, 211-277` |
| TrueFoundry gateway coupling | Optional. Provider type `truefoundry` adds `x-tfy-metadata` and an `anthropic-beta` header. A "TrueFoundry mode" (needs `STANDALONE=false` and a ServiceFoundry URL) reads models, MCP servers, skills and users from TrueFoundry. "Models and MCP from a gateway" is on the roadmap. | `VercelAILLM.ts:152-209`; `TF packages/trueforge/src/config.ts:1456-1460`, `src/truefoundry/`; `TF docs/roadmap.mdx` |
| MCP | Remote streamable HTTP and SSE, static headers or OAuth (in-chat "Connect"). Tool selectors `@all`, `@read-only`, `@write`, `@destructive`, or literal names. | `TF .../core/mcp/RemoteMCP.ts:43-57`, `remoteMcpClient.ts`, `toolSelectors.ts:7-43` |
| Approvals | Default `require_approval_for_tools` is `@write` and `@destructive`, read from MCP tool annotations. A pause ends the turn (`turn.done` with `required_actions`); the reply is a new turn with `user.tool_approval` (`allow` or `deny` plus reason). "Allow for this session" is `user.tool_approval_policy`. | `toolSelectors.ts:28`; `TF docs/api/use-agent.mdx:483-540`; `TF .../core/events/schema.ts:46, 104-133` |
| Ask the user | `ask_user_question`: one question, 0 to 5 single-choice options, free text always allowed. A client-side tool; the turn ends with `tool.response_required`. | `TF .../core/capabilities/builtins/AskUserQuestion.ts:9-20` |
| Sandbox | "Sandbox as a tool": the loop and keys stay in the server; the sandbox only runs `exec` (the one sandbox tool). Docs: "Daytona is the only sandbox provider supported today." Code also has a TrueFoundry provider and, in standalone mode, a local provider on `@anthropic-ai/sandbox-runtime` (bubblewrap, socat and ripgrep on Linux; seatbelt on macOS). Default sandbox egress is unrestricted. | `TF docs/sandbox.mdx:21-31, 100`; `TF .../core/sandbox/Sandbox.ts:111, 232-238`; `TF packages/trueforge/src/runtime/sessionResources.ts:152-178`; `src/sandbox/local/core/hostRun.ts:132-136` |
| Skills | Git-backed `SKILL.md` packs; name and description in the prompt, body read from the sandbox on demand. Need a sandbox. | `TF docs/key-features/overview.mdx`; `TF .../core/sandbox/skills/ISkillMounter.ts` |
| Deferred tool loading | By default a server shows only its name; the model calls `list_tools`, `get_tool_info`, `get_tool_output_schema`, `call_tool`. | `TF .../core/runtime/DeferredTool.ts:22-27` |
| Large result offload | A result over 6,000 tokens (or 10,000 in total) is written to a sandbox file; a 100-character preview stays in context. | `TF .../core/capabilities/builtins/LargeToolResponse.ts:17-19` |
| Compaction | Summarizes history at 80% of the model's context length (50,000 tokens if unknown) with a nine-section summary prompt. On by default. | `TF .../core/capabilities/builtins/ContextCompaction.ts:14-41` |
| Code Mode | The model writes Python that calls MCP tools through `mcp_client` in the sandbox; the server makes the authenticated call (NATS for remote sandboxes, a Unix socket locally). Approval rules still apply. | `TF docs/key-features/code-mode.mdx:15, 59`; `TF .../core/sandbox/codeMode/` |
| Subagents | Dynamic only: `create_sub_agent(name, input[, model])`. Same tools and sandbox as the parent, no parent history, run in parallel. | `TF .../core/capabilities/builtins/DynamicSubAgents.ts:74-120` |
| Schedules | Cron for a saved agent, hourly at the shortest, run by the server's controller. | `TF docs/schedules.mdx`; `TF packages/trueforge/src/controller/scheduleDispatch.ts` |
| Other | Generative UI (OpenUI blocks), web search (Parallel), memory (Zep, server only), turn metrics with USD cost, OpenTelemetry hooks, Prometheus metrics, file upload and download. | `TF .../core/capabilities/builtins/`; `.../agent-session/schemas/turn.ts:57-100`; `TF packages/trueforge/src/memory/zep` |

## 2. TrueForge compared with kagent and our agent

kagent here means 1.0.0-alpha17, the pinned version. Its stock runtime is the Go ADK. Our agent
is `agent/`.

| Feature | kagent 1.x (stock runtime + platform) | Our byo agent (`agent/`) | TrueForge 0.183.1 |
|---|---|---|---|
| Runs agents on Kubernetes (CRDs, controller) | Yes: `Harness`, `AgentTemplate`, `Agent`, `ModelConfig`, `RemoteMCPServer`, `EgressPolicy` (`KA go/api/v1alpha3/`) | Uses kagent's | No. A Deployment and a Helm chart for the server only (`TF charts/trueforge`) |
| Per-session isolation | Substrate actor per session, gVisor, snapshot and restore (Repo `docs/how-it-works.md`) | Uses kagent's | None for the loop; one server process for all sessions. The sandbox is per session |
| Protocol | A2A over gRPC to the actor (Repo `docs/byo-contract.md` rule 1) | A2A over gRPC (`agent/src/server.ts`) | REST plus SSE, OpenAPI, TS and Python SDKs. No A2A |
| Session and task state | Controller `TaskStoreService` (Repo ADR 0001) | Controller tasks plus `/data/sessions/<ctx>/state.json` | Its own SQLite or Postgres (+ Redis for many replicas) |
| Other harnesses as runtimes | Yes: `kagent`, `codex`, `claude`, `byo` Harness kinds; shared Go A2A executor (`KA go/api/v1alpha3/harness_types.go:105-111`, `KA go/harness/README.md`; *rc2*) | Is one (byo) | It is a harness; no runtime plug-in model |
| Credential handling | Egress gateway swaps placeholders for the agent key and actor JWT (Repo `docs/guard-rails.md`) | Holds placeholders only | Keys in its DB or env; kept out of the sandbox (`TF docs/sandbox.mdx:25`) |
| Model calls | `ModelConfig`; through agentgateway in this repo | OpenAI-compatible client to agentgateway (`agent/src/gateway.ts`) | Ten provider types incl. `custom` OpenAI-compatible (`VercelAILLM.ts:59-70`) |
| MCP tools | Template binds tools; stock runtime calls them (Repo ADR 0003 §2) | Own client, per-turn connections, `x-agent-key` (`agent/src/mcp-tools.ts`) | Own client, header auth or OAuth, tool selectors |
| Tool approval (HITL) | `tool_approval_request` with approve, approve for session, deny (`KA go/adk/pkg/a2a/hitl.go`; the wire shape is in `agent/src/hitl.ts`) | Same, plus a gate on non-read-only `bash` (`agent/src/approval.ts`, `shell-tool.ts`) | MCP only, default `@write`/`@destructive` by annotation; allow for session. `exec` is not gated |
| Ask the user | `ask_user_request`: several questions, choices, multi-select (`agent/src/hitl.ts`) | Same | One question, up to 5 single choices |
| Built-in code tools | `read_file`, `write_file`, `edit_file`, `list_files`, `grep_file`, `bash` (`KA go/adk/pkg/tools/builtin.go`) | File tools with path checks, `bash`, `search`, diff artifact | Only `exec` in a sandbox |
| Subagents | Named templates with their own model and prompt (Repo ADR 0003 §3) | Named, in process; role limits tools (`agent/src/subagents.ts`) | Dynamic only, same tools, parallel |
| Skills | Template skill images (Repo `docs/how-it-works.md`) | `load_skill` from images and workspace (`agent/src/skills.ts`) | Git-backed, need a sandbox |
| Context compaction | Yes, configurable on the Harness (`KA go/api/v1alpha3/harness_types.go:31-90`, `go/adk/pkg/agent/compaction.go`) | No. Output cap and pruning of old tool results (`agent/src/context.ts`) | Yes, on by default |
| Deferred tool schemas | Not found | No | Yes |
| Large result offload | Not found | Truncation at 20,000 characters | Yes, to a sandbox file |
| Code Mode (scripted tool calls) | Not found | No | Yes |
| Long-term memory | Yes, memory service and `save_memory` (`KA go/adk/pkg/memory/`) | No | Zep, server only |
| Schedules | Yes, controller-side `ScheduledRun` (`KA go/api/scheduledrun/schedule.go`, `go/core/internal/controller/scheduledrun/`) | No | Yes, in-process controller |
| UI | kagent UI renders HITL pauses (Repo ADR 0001 §4) | CLI (`agent/src/cli.ts`) | Chat UI, UI SDK, Generative UI |
| Guard rails (caps, tool allow list, repo list) | Platform rails at agentgateway (Repo `docs/guard-rails.md`) | Inherits them | None of these; it trusts its configured providers |
| Implement loop (`/implement` issue to PR) | No | Yes (`agent/src/loop*.ts`) | No |
| Extensions (tool events) | No | `tool_call`/`tool_result` modules (Repo ADR 0002) | Capabilities and context processors in code (`TF .../core/capabilities/`) |

"Not found" means not in the alpha17 tree; it does not mean kagent never adds it.

- **Overlap:** MCP, HITL, skills, compaction, memory, subagents, sessions, UI, schedules. Here
  TrueForge and kagent's stock runtime do the same job in different languages.
- **Complementary:** kagent's actor isolation, task store, egress and credential injection,
  CRDs, and agentgateway rails. TrueForge has none of these and would need them under it.
- **TrueForge only:** deferred tool loading, large result offload, Code Mode, parallel dynamic
  subagents, in-chat MCP OAuth, Generative UI, per-turn USD cost.

## 3. TrueForge as a kagent byo harness

### Rule by rule

| Rule (Repo `docs/byo-contract.md`) | TrueForge meets it? | Gap | Adapter work |
|---|---|---|---|
| 1. A2A over gRPC, task-based | No | REST plus SSE only; no A2A code in the tree (a case-blind search for `a2a` finds only a CSS colour) | An A2A gRPC task server that turns a message into a turn and SSE events into status and artifact updates. Reuse `agent/src/server.ts` and `@a2a-js/sdk`. |
| 2. Bind `0.0.0.0:80` | No | Port 8790, host `localhost` by default | The adapter binds 80. Keep TrueForge on `127.0.0.1:8790`: local mode has no login. |
| 3. Open the port before `/readyz` | No | `/healthz` answers only after config, migrations and stores load | Reuse `early-listener.ts` and `readyz.ts`; hold connections until TrueForge's `/healthz` is 200. Its boot is paid on every wake (spike). |
| 4. Task store in the controller | No | TrueForge keeps sessions and turns in its own DB | Reuse `controller-task-store.ts` and `wire.ts`. Keep TrueForge's SQLite at `SQLITE_PATH=/data/...` (`TF packages/trueforge/src/config.ts:382`) as private state, as kagent's own harnesses keep a "native continuation ID" (`KA go/harness/README.md`). Map `contextId` to the TrueForge session in `/data`. |
| 5. Settle only at real boundaries | N/A | TrueForge has no settle | Settle on `turn.done`: no `required_actions` is `COMPLETED`, some is `INPUT_REQUIRED`, `error` is `FAILED`, `cancelled` is `CANCELED`. |
| 6. Read the runtime config | No | Config comes from env, its DB, the Settings API and YAML catalogs | Parse `KAGENT_CONFIG_JSON` (reuse `agent/src/config.ts`). At boot, write a `custom` model provider (base URL, `OPENAI_API_KEY` placeholder, model id and context length) and the MCP servers through `/api/v1/settings`. Send `agent.instruction` in an inline AgentSpec. Set `OUTBOUND_URL_ALLOWED_HOSTS` (see risks). |
| 7. Run subagents and MCP tools itself | Partly | MCP fits: HTTP and SSE, static headers. Subagents do not: kagent's named `sub_agents` have their own prompt and tools; TrueForge subagents are dynamic copies of the parent | Register each `http_tools`/`sse_tools` binding as an MCP server with `x-agent-key`; set `enable_tools` to the binding's tools. For subagents, at most pass their models as a model set; the explorer's read-only role is lost. |
| 8. HITL pauses | Mostly | The pause model matches: a pause ends the turn and the reply is a new turn. Two gaps: the default rule gates only annotated tools, and `exec` has no gate | Map `tool.approval_required` to `tool_approval_request` and back to `user.tool_approval`; "approve for session" to `user.tool_approval_policy`; `ask_user_question` to a one-question `ask_user_request`. For a `requireApproval` binding pass literal names (or `@all`), never the default. Keep the HITL id mapping in `/data`. |
| 9. Honor the egress trust bundle | Likely for Node | Node calls use undici's default TLS with no pinning; custom CAs are opt-in mTLS only (`TF packages/trueforge/src/http/tls.ts:63-77`). Python in the sandbox (skills, Code Mode) has its own CA store | None for an MCP-only agent. With a sandbox, point Python at the bundle (spike). |

### The questions in the brief

- **A2A:** none, in any version or transport. The adapter is A2A gRPC on one side and the
  TrueForge HTTP API on the other (shape a), or A2A gRPC on one side and `trueforge-core` calls
  on the other (shape b).
- **Session state:** two stores. kagent's controller holds the A2A tasks (public history, what
  the UI shows). TrueForge holds the model context, turns and events (private). Both must
  agree on one `contextId` to session mapping, kept in `/data`.
- **Sandbox in a sandbox:** the actor is already a gVisor sandbox with narrow egress. Daytona
  would send the workspace and commands to an outside service: a new egress host, a Daytona
  key in the actor, and code leaving the cluster. That breaks the "no credential in the actor"
  rail. The local provider needs bubblewrap and user namespaces inside gVisor, and runs its own
  egress proxy over Substrate's; neither has been tried. In server mode there is no way to add
  our own provider without a fork; in library mode the `SandboxProvider` interface has 19
  members, three optional (`TF packages/trueforge-core/src/core/sandbox/provider/Provider.ts:107-155`).
- **Model calls through agentgateway:** yes, with the `custom` type. It uses
  `createOpenAICompatible` with base URL and key (`VercelAILLM.ts:133-150`), the same client our
  agent uses. Do not use type `openai`: it calls the Responses API (`VercelAILLM.ts:223`), and
  our ModelConfig is `apiFormat: chatCompletions`. The SSRF guard refuses
  `agentgateway-proxy.agentgateway-system.svc.cluster.local` (suffix `.local`, and a private
  IP) until the host is in `OUTBOUND_URL_ALLOWED_HOSTS` (`TF .../core/util/ssrfGuard.ts:70-120, 156-172`;
  `TF packages/trueforge/src/main.ts:45-49`).
- **MCP through our gateway:** yes, with the same allow-list entry; the MCP client uses the same
  guard (`TF .../core/mcp/remoteMcpClient.ts:210`). Static `x-agent-key` headers fit.
- **Approvals and `INPUT_REQUIRED`:** they map well, because both end the turn on a pause
  (table above). This is the best part of the fit.
- **UI and long-lived process:** the UI is not needed; the kagent UI shows the pause. The
  server is long-lived, and that conflicts in three places. Schedules and memory ingest run in
  an in-process controller, which does not run while the actor is suspended; use kagent's
  `ScheduledRun`. TrueForge's shutdown drain waits for SIGTERM (`TF packages/trueforge/src/main.ts:1007-1034`),
  but a suspend sends no signal (Repo `docs/how-it-works.md`). That is safe only because kagent
  suspends after a settle, when no turn runs. A wake starts the process cold (Repo ADR 0001 §2),
  so TrueForge's boot is paid on every message after idle.

### Verdict

**Works with an adapter (medium) for an agent with MCP tools and the sandbox off. Poor fit for
a coding agent today.**

- Adapter size for shape (a): reuse about 600 lines of `agent/src` (start-up, A2A server, task
  store, HITL codecs, config). Write about 1,000 new lines: start TrueForge as a child process,
  seed settings from the config, map sessions, stream SSE to A2A, map HITL both ways, cancel.
  Plus tests against a fake TrueForge. Roughly one to two weeks.
- What it would not have: code tools (no sandbox), named subagents, our bash gate, our
  extensions, the diff artifact, `/implement`.

### Top risks

1. **Churn.** A minor every two to five days, rc builds between, no compatibility promise in
   core. A digest pin holds the image still, but every upgrade is a re-check.
2. **The sandbox.** No provider fits a Substrate actor without a fork or an untried bubblewrap
   path, and without one there is no coding.
3. **Approval gaps.** Unannotated MCP tools are not gated by the default selector
   (`toolSelectors.ts:39`), and `exec` is never gated. The adapter must always send literal
   names, or a `requireApproval` rail silently opens.
4. **SSRF guard.** Every in-cluster host (gateway, MCP) must be allow-listed. Setting
   `NETWORK_POLICY_ENABLED=false` would also work, but it removes a layer for nothing.
5. **Token caps.** HTTP 429 is retried (`TF .../core/util/ssrfGuard.ts:40`, up to
   `MODEL_HTTP_MAX_RETRIES`, default 2), so a capped agent makes three refused calls per
   step. Set the retries to 0 in the adapter.

## 4. Integration shapes

### (a) TrueForge server plus a thin A2A-gRPC adapter, one byo image

```
router ── A2A gRPC :80 ──> adapter (agent/src start-up, server, task store, HITL)
                              │  HTTP + SSE on 127.0.0.1:8790
                              v
                           TrueForge server (STANDALONE, SQLite in /data, sandbox off)
                              │  custom provider, MCP servers (allow-listed hosts)
                              v
                           agentgateway /v1, /mcp/*
```

- **For:** TrueForge runs as shipped; upgrades are a new image; the adapter is mostly our code.
- **Against:** two processes and two stores per actor; boot cost on every wake; no sandbox,
  so no code tools; settings must be re-seeded on each boot from the config.

### (b) `trueforge-core` as a library inside our byo shell

Keep `agent/src` for A2A, the task store, HITL and config. Replace the AI SDK
`ToolLoopAgent` turn with `Sessions` and `createTurn`. Write a file-backed `ISessionStore` in
`/data` (24 methods), a `SandboxProvider` over `/data/workspaces/<ctx>` with no nested
isolation (the actor is the sandbox), and call `configureOutboundUrlGuard` with the gateway
host.

- **For:** one process; we choose the sandbox; TrueForge's context handling with our rails.
- **Against:** the largest piece of work (about 2,000 lines); no compatibility promise in
  core; AI SDK 7 and zod 4 next to our 6 and 3; our file tools, bash gate, extensions and diff
  would have to be rebuilt as TrueForge capabilities; Code Mode needs a transport we write.

### (c) Borrow the techniques into `agent/` (recommended)

Port the ideas, not the package. In order of value for a coding agent:

1. **Compaction** at a share of the context length, with TrueForge's summary sections
   (`ContextCompaction.ts`). Our pruning drops old tool results but never summarizes.
2. **Large result offload:** write a result over a token limit to a workspace file and keep a
   preview (`LargeToolResponse.ts`). Better than our 20,000-character cut, and the file tools
   can read it.
3. **Deferred MCP tool loading:** `list_tools`, `get_tool_info`, `call_tool`
   (`DeferredTool.ts`). Worth it once an agent binds many MCP tools; GitHub MCP has dozens.
4. **Parallel subagents** for read-only fan-out, kept inside our named roles.

- **For:** no new runtime, no second store, the guard rails stay as they are, MIT allows it
  (keep the notice on copied code).
- **Against:** we own the code and do not get upstream fixes.

### (d) A kagent-native TrueForge harness (later, upstream)

kagent already wraps Claude Code and Codex as native runtimes: a controller-side translator
plus an actor-side driver on a shared Go A2A executor with a `PendingTurn` HITL contract
(`KA go/harness/README.md`, `go/harness/runtime/a2a/executor.go`; *rc2*). A TrueForge driver
would follow that pattern, talking to the TrueForge API as its "native process". It is the
cleanest shape, but it is kagent's to accept. `go/harness/runtime/a2a` is a public package of
the `go` module, so a byo image could import it; that has not been tried.

## Open questions only a spike can answer

1. Does the local SRT sandbox (bubblewrap, socat) start inside a gVisor actor, and what does
   its egress proxy do under Substrate's egress gateway?
2. How long does TrueForge boot on a cold wake (config, SQLite migrations, catalogs, sandbox
   probe), and does it fit before the router's first message?
3. Does SQLite (better-sqlite3, WAL) in `/data` survive snapshot and restore with no lost
   turn?
4. Does a `custom` provider through agentgateway return token usage and stream correctly
   (`includeUsage: true`), and does compaction pick up the model's context length from the
   seeded provider?
5. Does a turn paused on `tool.approval_required`, then suspended and restored, resume with the
   approval as a new turn and run the tool once?
6. Which GitHub MCP tools carry `readOnlyHint` and `destructiveHint`, so we know what the
   default selector would have left ungated?
7. Can `resolveAgentDefinition` with `agent_info` (library mode) give a subagent its own prompt
   and a read-only tool set, so kagent's named subagents map?
8. Does the kagent UI render a pause whose request id is a TrueForge tool call id, and can it be
   answered from the UI?
