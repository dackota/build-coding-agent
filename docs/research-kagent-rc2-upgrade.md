# Research: kagent v1.0.0-alpha17 to v1.0.0-rc2

What changed in kagent (alpha17 to rc2) and Agent Substrate (0.6.0-alpha3 to 1.0.0-rc2) that
affects this repo, and what the upgrade must change here. Read from source on 2026-11-04 (tags,
PRs, release API, OCI registries). Nothing was installed on a cluster.

## Answer

- **The upgrade is a pin bump plus one manifest fix.** kagent's API stays `api.kagent.dev/v1alpha3`
  and every field the repo sets still exists at rc2. The one hard break: Substrate serves
  WorkerPool only as `ate.dev/v1`; `ate.dev/v1alpha1` is gone. `team-base.yaml` must change.
- **rc2 names Substrate v1.0.0-rc2.** `go/go.mod` at rc2:
  `go.ate.dev/substrate => github.com/kagent-dev/substrate v1.0.0-rc2`. Charts and images exist at
  that version. Substrate has a git tag for it but no GitHub Release page.
- **No in-place upgrade.** Substrate squashed its database migrations in v0.7.0-alpha2, changed the
  node image cache in rc1, and old gVisor memory snapshots do not restore. Rebuild the cluster
  (`make down && make up`). `install.sh` skips kagent and Substrate when their releases are
  deployed, so a plain `make up` on an old cluster would keep alpha17.
- **The byo contract holds.** The TaskStore proto, the byo compiler, the config and card env vars,
  the identity path, ports 80 and 8081, the HITL extension and the trust bundle are unchanged.
  Rule 2's loopback bug has no fix in either diff; only a live run can tell.
- **One change our agent should copy:** kagent's Go runtime now retries TaskStore calls for up to
  two minutes (#3391). Ours (and the starter's) gives up after 4 attempts in about 0.7 s, which is
  the failure #3391 fixed: a controller restart leaves the task `WORKING`.
- **ADR 0003 stands.** rc2's "discover and invoke agents" (#3486) is for users, not actors. An
  actor's `list_agents` returns only itself, it cannot create another agent's Session, and there is
  still no agent-as-tool field. Only the tool name changed: `invoke_session` is now `invoke_agent`.
- **Found while checking, also true on alpha17:** the kagent chart ignores
  `controller.image.digest` and `ui.image.digest`, so `install.sh`'s controller and UI digest
  pins never take effect. Only `make status` catches a moved tag.

### What to change here

1. `platform/versions.env`: the values in [New pins](#new-pins).
2. `platform/charts/teams/templates/team-base.yaml:24`: `apiVersion: ate.dev/v1`.
3. `platform/install.sh` (`write_cli_files`): pin the controller and UI as
   `image.tag: <version>@sha256:<digest>` instead of `image.digest` (see
   [The digest pins](#the-digest-pins-do-not-apply)).
4. `platform/images.lock`: the new digests in [New pins](#new-pins); confirm against running
   pods.
5. `agent/test/teams-chart.test.ts:7` and `agent/test/minter-chart.test.ts:9`: the new worker image.
6. `platform/kagent-values.yaml:22-23`: drop `grafana-mcp` (the subchart is gone, #3294).
7. `agent/src/controller-task-store.ts` and `templates/byo-ts/src/task-store.ts`: a retry budget
   like #3391's.
8. Docs: `docs/pinned-versions.md`, and the alpha17 text in `docs/byo-contract.md` (rule 2),
   `agent/src/main.ts:8`, `agent/src/wire.ts:1`, `agent/Dockerfile` (its comment still says
   `127.0.0.1:80`), `docs/decisions/0003-a2a-and-stock-runtime.md` and
   `docs/building-on-the-platform.md:263` (`invoke_session`).

## Breaking changes

| Change | Affects this repo? | File(s) here to change | Source |
|---|---|---|---|
| WorkerPool served only as `ate.dev/v1` (v1alpha1 removed); same spec fields | **Yes**: the team WorkerPool fails to apply | `platform/charts/teams/templates/team-base.yaml:24` | [substrate-crds `ate.dev_workerpools.yaml:51` at v1.0.0-rc2](https://github.com/kagent-dev/substrate/blob/v1.0.0-rc2/charts/substrate-crds/templates/ate.dev_workerpools.yaml); [kagent `substrate-workerpool.yaml:5` at rc2](https://github.com/kagent-dev/kagent/blob/v1.0.0-rc2/helm/kagent/templates/substrate-workerpool.yaml); [kagent `helm/README.md:70`](https://github.com/kagent-dev/kagent/blob/v1.0.0-rc2/helm/README.md) |
| No in-place Substrate upgrade: migrations squashed (v0.7.0-alpha2), image cache format (rc1), gVisor MEMORY snapshots do not restore | **Yes**: rebuild the cluster | none; `install.sh` skips deployed releases, so run `make down` first | [kagent `helm/README.md` at rc2](https://github.com/kagent-dev/kagent/blob/v1.0.0-rc2/helm/README.md) ("Rc1 also changes...", "v0.7.0-alpha2 squashed..."); kagent-dev/kagent#3457; [substrate 209b0f4](https://github.com/kagent-dev/substrate/commit/209b0f4fae653730d7c7cb584904a48eb64ba430) |
| Actor ingress needs mTLS and a SPIFFE allowlist; router URL is now `https://atenet-router.ate-system.svc:443` | No: `kagent install` sets both, and our Substrate values file does not override `atenetRouter` | keep `platform/substrate-values.yaml` to `credentialProvider` only | kagent-dev/kagent#3457; [`go/core/pkg/install/plan.go:203-220` at rc2](https://github.com/kagent-dev/kagent/blob/v1.0.0-rc2/go/core/pkg/install/plan.go); [`helm/README.md:75`](https://github.com/kagent-dev/kagent/blob/v1.0.0-rc2/helm/README.md) |
| Harness `snapshotPolicy.location` needs Substrate's `PerTemplateSnapshotLocation` preview gate | No: the CLI enables it | do not add a `preview:` list to `platform/substrate-values.yaml` without it | [`helm/README.md:96`](https://github.com/kagent-dev/kagent/blob/v1.0.0-rc2/helm/README.md); [`plan.go:205-206`](https://github.com/kagent-dev/kagent/blob/v1.0.0-rc2/go/core/pkg/install/plan.go) |
| `Harness.status` removed | No: nothing here reads it | none | kagent-dev/kagent#3454; [`harness_types.go` at rc2](https://github.com/kagent-dev/kagent/blob/v1.0.0-rc2/go/api/v1alpha3/harness_types.go) |
| ADK config `agent.network` and `agent.share_tools` removed | No: `agent/src/config.ts` reads neither | none | kagent-dev/kagent#3454; [`proto/kagent/config/v1/adk.proto` at rc2](https://github.com/kagent-dev/kagent/blob/v1.0.0-rc2/proto/kagent/config/v1/adk.proto) |
| MCP tool `invoke_session` renamed `invoke_agent`; `list_agents` added | Docs only | `docs/decisions/0003-a2a-and-stock-runtime.md`, `docs/building-on-the-platform.md:263` | kagent-dev/kagent#3486; [`go/core/internal/mcp/server.go:29,104`](https://github.com/kagent-dev/kagent/blob/v1.0.0-rc2/go/core/internal/mcp/server.go) |
| Session API: `SuspendSession`/`ResumeSession` removed; `Session.agent` is now `{ref, uid}` | No: the repo calls only the A2A endpoint and TaskStore | none | kagent-dev/kagent#3409, kagent-dev/kagent#3453 |
| `grafana-mcp` subchart removed | Cosmetic: our `enabled: false` is now a dead key (the chart has no values schema) | `platform/kagent-values.yaml:22-23` | kagent-dev/kagent#3294 |
| `modelConfig` and MCP `server` refs gain an optional `namespace`; same-namespace stays the default | No | none | kagent-dev/kagent#3382; [`agenttemplate_types.go` at rc2](https://github.com/kagent-dev/kagent/blob/v1.0.0-rc2/go/api/v1alpha3/agenttemplate_types.go) |
| `tokenPassthrough` is `*bool`; credential choices are unions (`actorJwt`, `apiKeySecret`, `tokenPassthrough`) | No: the repo sets none of the options it must omit | none | kagent-dev/kagent#3359 |
| INPUT_REQUIRED and AUTH_REQUIRED turns now expire after the Session idle TTL (7 days by default) | Behavior: a pause unanswered for 7 days ends the Session | `docs/byo-contract.md` rule 8, `docs/using-the-agent.md` (one line each) | kagent-dev/kagent#3254; [`runtime-and-lifecycle.md:119`](https://github.com/kagent-dev/kagent/blob/v1.0.0-rc2/docs/architecture/runtime-and-lifecycle.md); chart `config.sessions.idleTtl: 604800s` |
| Substrate's egress and router gateway is now upstream `cr.agentgateway.dev/agentgateway:v1.7.0` (was `ghcr.io/kagent-dev/substrate/agentgateway`) | `images.lock` only; the gateway that swaps our placeholders is new code | `platform/images.lock` | [substrate `charts/substrate/values.yaml:243`](https://github.com/kagent-dev/substrate/blob/v1.0.0-rc2/charts/substrate/values.yaml) |
| `/tmp` is a tmpfs on both runtimes; `/run` comes from the image | Probably no: the agent keeps state under `/data` | none | [substrate 209b0f4](https://github.com/kagent-dev/substrate/commit/209b0f4fae653730d7c7cb584904a48eb64ba430) |
| `capabilities.add` limited to an allowlist | No: we add none, and the default set keeps `NET_BIND_SERVICE` | none | [substrate e59281c](https://github.com/kagent-dev/substrate/commit/e59281c766d547689482a1fce666ca3f0f6bd008) |
| Controller RBAC narrowed and split into two Roles | No: cluster-wide install, and the controller still reads Secrets and ConfigMaps everywhere | none | kagent-dev/kagent#3378 |

Every `kind:` under `api.kagent.dev` and `ate.dev` in `platform/` and `platform/charts/` was checked
against the packaged rc2 CRDs (`helm pull`, then each field path looked up in the CRD schema):
ModelConfig, AgentTemplate, Agent, Harness, RemoteMCPServer and EgressPolicy are served at
`v1alpha3` and have every field the repo sets; WorkerPool has every field at `v1` only. The
conditions `make status` and `make deploy` read still exist: Agent `Ready` and `Compatible`
([`agent_types.go:86-87`](https://github.com/kagent-dev/kagent/blob/v1.0.0-rc2/go/api/v1alpha3/agent_types.go)),
ModelConfig `Accepted`, WorkerPool `status.readyReplicas`. The AppProject's allowed kinds
(`platform/charts/teams/templates/argocd.yaml`) need no change. The SandboxConfig `gvisor-default`
still ships in the substrate chart (`templates/sandboxconfig-gvisor.yaml`).

## New pins

Chart digests are what `helm pull` printed. Image digests are index digests from the ghcr.io
registry API (`docker buildx imagetools` is not installed here); the same method returned exactly
the alpha17 and 0.6.0-alpha3 digests already in `versions.env` and `images.lock`. CLI checksums are
the release API's asset digests, and match the `.sha256` files of the release.

| `versions.env` key | Value | Source |
|---|---|---|
| `KIND_VERSION` | `v0.32.0` (unchanged) | [kagent 1.x install guide](https://github.com/kagent-dev/website/blob/93a7eac4d3880e802e8f1062315166d3039acecc/docs-site/content/kagent/1.x/setup/installation.md): "Kubernetes 1.37 or later. Use kind v0.32.0 or later" |
| `KIND_NODE_IMAGE` | `kindest/node:v1.37.0@sha256:a1ed56cf...` (unchanged) | same guide |
| kind config | unchanged at rc2 | `scripts/kind/kind-config.yaml` has no diff alpha17..rc2 |
| `KAGENT_VERSION` | `1.0.0-rc2` | https://github.com/kagent-dev/kagent/releases/tag/v1.0.0-rc2 (commit `4a5c758598a983c47ea14ea1757b191db8423884`) |
| `KAGENT_CLI_SHA256_DARWIN_ARM64` | `58ce05822d113da6527b4fe03e5308b155764e81fe8e6f0a82fea5ab01c059a1` | release API asset digest |
| `KAGENT_CLI_SHA256_DARWIN_AMD64` | `eda2e06ed53c63fce5be4f998ff3ccde6fbbcb1db6600341d11e3291897dbf91` | same |
| `KAGENT_CLI_SHA256_LINUX_ARM64` | `136f4a57ee2252dd2f6dbe042b9857b0ac471fafea8aad006dfe92e928a0ce38` | same |
| `KAGENT_CLI_SHA256_LINUX_AMD64` | `bc6f2104204a36ccfe16ffc135b82c63c741f4bf3d065447d929b0e0d567eef4` | same |
| `KAGENT_CHART_DIGEST` | `sha256:d8707ae2e9d0f6d2db10a9f2ef0bdbe0e6eb3f8bf5913d820da6b21d58e1ad72` | `helm pull oci://ghcr.io/kagent-dev/kagent/helm/kagent --version 1.0.0-rc2` (the OCI digest; the release's `.tgz` asset has another sha256, `2d5e7e5f...`, which `install.sh` does not compare) |
| `KAGENT_CRDS_CHART_DIGEST` | `sha256:6d0a285a230ae08e707eee5faef16dac9a059b120685b64ad38954ac2352bebc` | `helm pull .../kagent-crds --version 1.0.0-rc2` |
| `KAGENT_CONTROLLER_DIGEST` | `sha256:1420365cc2dd8f4d37000ddac462b03df38b363f3118d715cb6631c39243f349` | ghcr.io `kagent-dev/kagent/controller:1.0.0-rc2` |
| `KAGENT_UI_DIGEST` | `sha256:710fe7f2c306ae4e5c010a44b9e44ae4c8f286d31d4a6d1a6d427bb02c40d3e1` | ghcr.io `kagent-dev/kagent/ui:1.0.0-rc2` |
| `SUBSTRATE_VERSION` | `1.0.0-rc2` | [kagent `go/go.mod:515` at rc2](https://github.com/kagent-dev/kagent/blob/v1.0.0-rc2/go/go.mod); kagent-dev/kagent#3520 |
| `SUBSTRATE_CHART_DIGEST` | `sha256:c02c1df871f1a41d36c90881508f38be36170eb8cc48a163a3c7ec1508a14fd6` | `helm pull oci://ghcr.io/kagent-dev/substrate/helm/substrate --version 1.0.0-rc2` |
| `SUBSTRATE_CRDS_CHART_DIGEST` | `sha256:ef8c8029a32db8cc21b56f60129a8bc594b6532a208bff6ec3a8016dc5a08a2d` | `helm pull .../substrate-crds --version 1.0.0-rc2` |
| `SUBSTRATE_PODCERT_CHART_DIGEST` | `sha256:730a0b0181fc24cca7feb09154fc085e7001a9dcde2e480a0e997f6ff44b8d70` | `helm pull .../substrate-podcert --version 1.0.0-rc2` |
| `SUBSTRATE_WORKER_IMAGE` | `ghcr.io/kagent-dev/substrate/ateworker-gvisor:v1.0.0-rc2@sha256:921de912cd9080bc13e296e5a4f758e59353fdd399d0ae97f32a471c15ccbce9` | ghcr.io; the tag is the one the rc2 CLI sets ([`install.go:108`](https://github.com/kagent-dev/kagent/blob/v1.0.0-rc2/go/core/cli/internal/commands/install.go)) |
| `POSTGRES_IMAGE` | `postgres:18-alpine@sha256:9a8afca5...` (unchanged) | [`go/core/pkg/config/defaults.go:22` at rc2](https://github.com/kagent-dev/kagent/blob/v1.0.0-rc2/go/core/pkg/config/defaults.go) |

`images.lock` changes (index digests read the same way; **not verified against running pods**,
which is what `images.lock` records):

| Image | rc2 digest | Source |
|---|---|---|
| `ghcr.io/kagent-dev/kagent/controller` | `sha256:1420365c...` | above |
| `ghcr.io/kagent-dev/kagent/ui` | `sha256:710fe7f2...` | above |
| `ghcr.io/kagent-dev/kagent/golang-adk` | `sha256:1f2f72c1743dad076beb4a7d12c1d6313f3814ec5ab56204c99783747a8451bc` | rc2 chart `files/builtin-harness-images.json`; ghcr.io agrees |
| `ghcr.io/kagent-dev/kagent/tools` | `sha256:cb89eb76...` (unchanged; subchart still 0.3.0) | rc2 chart `Chart.yaml` |
| `ghcr.io/kagent-dev/substrate/ateworker-gvisor` | `sha256:921de912...` | above |
| `ghcr.io/kagent-dev/substrate/ateapi` | `sha256:99a00b72c1308535643d7df2a6085c95165f1b8aa8d88efef2901729510625ca` | ghcr.io `:v1.0.0-rc2` (chart appVersion) |
| `ghcr.io/kagent-dev/substrate/atecontroller` | `sha256:366dc06558dbce7e372ed177774f0cda3a31b14bee17a767b035223cfcb360a1` | same |
| `ghcr.io/kagent-dev/substrate/atelet` | `sha256:5b2e24cb355a37909d9b9bdbd60317d609f8c3c18a73d39b1405ee805fd8b4d7` | same |
| `ghcr.io/kagent-dev/substrate/ate-idp-server` | `sha256:4e8fe64e22ecb4ee2114e9e907922e2cb5244607c61a61e4e89579a8ed0ba0f1` | same |
| `ghcr.io/kagent-dev/substrate/kubernetes-secrets` | `sha256:7ebc67aae800a6cbb709dcf766e39b847b081aa94a091d77a9c8a6dd73fc6623` | same |
| `ghcr.io/kagent-dev/substrate/objectstore-plugin` | `sha256:ac6732dc5727971766a1b8ac732c43534e3120d1a72b2530c4c2a0d25f2b294f` | same |
| `ghcr.io/kagent-dev/substrate/podcertcontroller` | `sha256:bfed8c6bf03915e451e8e331fa073a261b4167ddfdd6c5af9f31b38f43329908` | same |
| `cr.agentgateway.dev/agentgateway` (Substrate's, v1.7.0) | `sha256:60216aafb03d37f94e952ff3d51d2f630a65b10ecaebdc0a864882f92610c45b`; replaces `ghcr.io/kagent-dev/substrate/agentgateway@sha256:309f6811...` | [substrate `values.yaml:243`](https://github.com/kagent-dev/substrate/blob/v1.0.0-rc2/charts/substrate/values.yaml) |
| `docker.io/rustfs/rustfs` (1.0.3) | `sha256:9ca9559533b537d10482fe923288b676ad08f92a7069d9a17327fbae3cab688b` | same file, line 241 |
| `docker.io/amazon/aws-cli` (2.38.5) | `sha256:c8156a0e74e13929a42d7e60f0d4e14e7d28d980cd21822505d4bff80e5460c1` | same file, line 242 |

Our own agentgateway (`AGW_VERSION=v1.6.0`) is a separate install and can stay. Substrate's
image line must be added to `images.lock` next to ours, not replace it.

### The digest pins do not apply

`install.sh` writes `controller.image.digest` and `ui.image.digest`. The chart's
`kagent.controllerImage` and `kagent.uiImage` helpers pass only `registry`, `repository` and `tag`
to the image template, so the digest never reaches it
([`helm/kagent/templates/_helpers.tpl:383-387, 432-436`](https://github.com/kagent-dev/kagent/blob/v1.0.0-rc2/helm/kagent/templates/_helpers.tpl);
the same text at [v1.0.0-alpha17](https://github.com/kagent-dev/kagent/blob/v1.0.0-alpha17/helm/kagent/templates/_helpers.tpl)).
`helm template` of the rc2 chart with our values and `controller.image.digest` set renders
`ghcr.io/kagent-dev/kagent/controller:1.0.0-rc2`. With
`controller.image.tag=1.0.0-rc2@sha256:1420365c...` it renders
`ghcr.io/kagent-dev/kagent/controller:1.0.0-rc2@sha256:1420365c...`, which pins the image.

## The byo contract at rc2

| Rule | At rc2 | Source |
|---|---|---|
| 1. A2A over gRPC, task-based | **Yes.** The byo card still advertises one gRPC interface. a2a-go moved 2.6.0 to 2.7.0; its new card enforcer (rejects unlisted input media types) is not enabled anywhere in kagent. | [`translator/byo/compiler.go:94`](https://github.com/kagent-dev/kagent/blob/v1.0.0-rc2/go/core/internal/translator/byo/compiler.go); `go/go.mod`; a2aproject/a2a-go#456; no `NewAgentCardEnforcer` in kagent at rc2 |
| 2. Bind 0.0.0.0:80 | **Unknown whether the bug is fixed; the rule stays safe.** The card still says `http://127.0.0.1:80`. Neither diff touches actor addressing. The stock runtime still listens on all interfaces. | `compiler.go:94`, [`translator/agentcard.go:21`](https://github.com/kagent-dev/kagent/blob/v1.0.0-rc2/go/core/internal/translator/agentcard.go); `go/adk/pkg/a2a/server/server.go` unchanged alpha17..rc2 |
| 3. Open the port before /readyz | **Yes.** A2A on 80, `/readyz` on 8081. The router parks requests to a waking actor for up to 5 s (now a Helm value). | [`runtime-and-lifecycle.md:241-242`](https://github.com/kagent-dev/kagent/blob/v1.0.0-rc2/docs/architecture/runtime-and-lifecycle.md); [substrate `values.yaml:148`](https://github.com/kagent-dev/substrate/blob/v1.0.0-rc2/charts/substrate/values.yaml) |
| 4. TaskStore with the placeholder bearer, identity read per call | **Yes, with a new recommendation.** `task_store.proto` is unchanged, so `agent/src/wire.ts` still matches. The placeholder and identity path are the same. kagent's Go client now retries `Unavailable`/`DeadlineExceeded` for up to 2 minutes (100 ms doubling to 1 s, jittered); ours stops after 4 attempts. | `proto/kagent/runtime/v1/task_store.proto` no diff; [`go/adk/pkg/taskstore/store.go:76`](https://github.com/kagent-dev/kagent/blob/v1.0.0-rc2/go/adk/pkg/taskstore/store.go); [`go/api/a2a/runtime.go:5`](https://github.com/kagent-dev/kagent/blob/v1.0.0-rc2/go/api/a2a/runtime.go); kagent-dev/kagent#3391 |
| 5. Settle only at real boundaries | **Yes.** Settlement semantics unchanged; only its retry and timeout changed. | kagent-dev/kagent#3391 (`go/adk/pkg/taskstore/executor.go`) |
| 6. Read the runtime config | **Yes.** Same `KAGENT_CONFIG_JSON` and `KAGENT_AGENT_CARD_JSON` env; `runtime.control_plane_url` default unchanged. New optional `runtime.builtin_tools.disable_ask_user`. | [`substrate/actor_template.go:80-81`](https://github.com/kagent-dev/kagent/blob/v1.0.0-rc2/go/core/internal/substrate/actor_template.go); [`config/defaults.go:50`](https://github.com/kagent-dev/kagent/blob/v1.0.0-rc2/go/core/pkg/config/defaults.go); kagent-dev/kagent#3298 |
| 7. Run subagents and MCP tools itself | **Yes.** Still resolved into config only. New: an MCP server may live in another namespace (its headers resolve there), and an `actorJwt` server gets an `Authorization: Bearer` placeholder header. `remote_agents` is still filled by nothing. | [`translator/adkconfig/builder.go`, `mcp.go`](https://github.com/kagent-dev/kagent/blob/v1.0.0-rc2/go/core/internal/translator/adkconfig/mcp.go); no `RemoteAgents` in `go/core` at rc2 |
| 8. Send HITL pauses | **Yes, with one behavior change.** Same extension URI and messages. A pause now expires with the Session after the idle TTL (7 days). kagent's runtimes now tell the model `Tool call was rejected by user. Reason: <reason>`; ours already passes the reason in its own words, and the kagent UI matches rejections by kagent's exact wording. | [`go/api/a2a/hitl.go:13`](https://github.com/kagent-dev/kagent/blob/v1.0.0-rc2/go/api/a2a/hitl.go); kagent-dev/kagent#3254, kagent-dev/kagent#2947; `agent/src/approval.ts:60` |
| 9. Honor the egress trust bundle | **Yes.** Same env vars and bundle path. The gateway that re-signs TLS is now agentgateway v1.7.0. | [`actor_template.go:43-44, 75-76`](https://github.com/kagent-dev/kagent/blob/v1.0.0-rc2/go/core/internal/substrate/actor_template.go) |

Rc1 also makes Substrate honor the image's user (kagent-dev/kagent#3457). Our images set no
`USER`, so they run as root, as before.

## ADR 0003 and agent-to-agent calls

#3486 adds `list_agents` and renames `invoke_session` to `invoke_agent`, which can start a
conversation with `agent: {namespace, name}`. It does not give actors new rights:

- The actor policy lets an actor get only its own Agent, list only that Agent, and get, send to or
  update only its own Session. "Empty create never grants a new Session."
  ([`runtimeauth/authorizer.go:24-55`](https://github.com/kagent-dev/kagent/blob/v1.0.0-rc2/go/core/internal/runtimeauth/authorizer.go))
- "Cross-agent delegation and configurable actor grants are not implemented."
  ([`a2a-gateway.md:241`](https://github.com/kagent-dev/kagent/blob/v1.0.0-rc2/docs/architecture/a2a-gateway.md))
- `TestMCPActorListsOnlyItsSession` still holds, and checks that `invoke_agent` refuses another
  Session ([`go/core/internal/mcp/auth_test.go:53`](https://github.com/kagent-dev/kagent/blob/v1.0.0-rc2/go/core/internal/mcp/auth_test.go)).
- `ToolBinding` is still exactly one of `mcp` or `subAgent`; no agent reference
  ([`agenttemplate_types.go:88-95`](https://github.com/kagent-dev/kagent/blob/v1.0.0-rc2/go/api/v1alpha3/agenttemplate_types.go)).

So all three of the ADR's retest items are still "no" at rc2. The ADR needs only the tool rename.

The other three PRs named in the brief:

- **#3378 (controller RBAC):** chart-only; no change for a cluster-wide install.
- **#3391 (TaskStore retries):** our agent should do the same (rule 4).
- **#2947 (rejection reason):** our agent already gives the model the reason; matching kagent's
  wording is optional.

## What rc1 and rc2 add that we could use

- **Actor JWTs** on ModelConfig, RemoteMCPServer and EgressPolicy (`actorJwt`, #3359), and
  `AgentIdentityService.ResolveAgentIdentity` (#3362). agentgateway could check which agent is
  calling from a Substrate-minted token instead of a minted per-agent key. Worth a spike against
  ADRs 0005, 0006 and 0008.
- **Cross-namespace ModelConfig and RemoteMCPServer** with `allowedNamespaces` (#3382). The team
  base could reference one shared ModelConfig instead of copying it into every team. Secrets stay
  local to the target, and our per-agent key header still needs a per-agent RemoteMCPServer.
- **`kagent install --dry-run --output-dir`** (#3432) writes the Helm commands and merged values.
  Useful to review what `install.sh` hands the CLI.
- **`config.runtimeDefaults.builtinTools.disableAskUser`** (#3298) for stock-runtime agents.
- **`outputSchemaStrict`** on AgentTemplate (#3284).
- **Golden builds retry** after a failure (#3335), and the router's parking budget is a Helm
  value (`atenetRouter.requestParking.budget`).
- **`list_agents` / `invoke_agent`** for a user-side client such as `make chat`.

## Open questions only `make up` on kind can answer

1. Does the router now reach an actor that listens on `127.0.0.1:80` (rule 2)? `make byo-check`
   cannot tell: it runs the image as a plain pod, not behind Substrate's router. Deploy a byo
   agent with `KAGENT_GRPC_ADDR=127.0.0.1:80` and send it a message.
2. Do `make smoke`, `make chat` and the byo agent's model and MCP calls work through Substrate's
   new egress gateway (agentgateway v1.7.0), with the placeholder swap and the re-signed TLS?
3. Does a woken agent answer within the router's 5 s parking budget? (Wake is a cold start of
   `node`.)
4. Do the running pods' `imageID`s match the digests above, so `make status` passes?
5. Does kagent's own kind config (feature gates, `certificates.k8s.io/v1beta1`) still install
   cleanly on 1.37? It is unchanged at rc2, but the install guide now says the cluster "does not
   need extra API configuration".
6. With the retry budget added, does a turn's final save survive
   `kubectl rollout restart deployment/kagent-controller` mid-turn (the #3391 test)?
7. Does the rc2 A2A gateway (a2a-go 2.7.0, which negotiates `application/a2a+json`) still accept
   our client's `content-type: application/json`?

## Repeat it

The diffs came from blobless clones of `kagent-dev/kagent` and `kagent-dev/substrate`
(`git diff v1.0.0-alpha17 v1.0.0-rc2`, `git diff v0.6.0-alpha3 v1.0.0-rc2`). Chart digests came
from `helm pull`; field checks came from the pulled CRDs; image digests came from
`HEAD https://ghcr.io/v2/<repo>/manifests/<tag>` with an anonymous pull token and the OCI index
media types. CLI checksums came from
`gh api repos/kagent-dev/kagent/releases/tags/v1.0.0-rc2 -q '.assets[]'`.
