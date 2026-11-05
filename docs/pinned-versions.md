# Pinned versions

The platform scripts read every version and digest below from one file,
`platform/versions.env`. The running images are listed in `platform/images.lock`, and
`make status` fails when a platform pod runs an image that is not in it. Change a pin
only on purpose, and change this page, `versions.env`, and `images.lock` together.

Read on 2026-10-21; the kagent and Substrate rows on 2026-11-04. Chart digests are what
`helm pull` printed; image digests are index digests from `docker buildx imagetools inspect`
or the ghcr.io registry API, or the `imageID` of the running pod where noted.

## Tools

| Part | Version | Pin | Source |
|---|---|---|---|
| kind | v0.32.0 | `preflight.sh` refuses another version | https://github.com/kubernetes-sigs/kind/releases/tag/v0.32.0 |
| Helm | major 3 or 4 (4.2.3 used) | `preflight.sh` refuses another major | https://helm.sh/docs/ |
| kagent CLI | v1.0.0-rc2 | SHA-256 per asset in `versions.env` (darwin-arm64 `58ce0582...`), checked on download into `.bin/` | https://github.com/kagent-dev/kagent/releases/tag/v1.0.0-rc2 (asset digests from the release API, equal to each asset's `.sha256` file) |

## Cluster and registry

| Part | Version | Digest | Source |
|---|---|---|---|
| kind node image (Kubernetes 1.37.0) | `kindest/node:v1.37.0` | `sha256:a1ed56cfb0e7b93589bdf97c8cd566405a265939e3620fc4f5de89adff580ae5` | https://hub.docker.com/r/kindest/node/tags; the kagent install guide names `kindest/node:v1.37.0` with kind v0.32.0 |
| kind config | kagent `scripts/kind/kind-config.yaml` | commit `8392184232e9c78196433a34b1fd3b33db5fcb97` (tag v1.0.0-alpha17); unchanged at v1.0.0-rc2 | https://github.com/kagent-dev/kagent/blob/v1.0.0-rc2/scripts/kind/kind-config.yaml |
| Local registry | `registry:2` | `sha256:a3d8aaa63ed8681a604f1dea0aa03f100d5895b6a58ace528858a7b332415373` | https://hub.docker.com/_/registry |
| Smoke image pushed to the registry | `busybox:1.37.0` | `sha256:bdf57e528e45e4433820e045b29b4597825a1c9e38353532d90a01445013f82e` | https://hub.docker.com/_/busybox |

## Charts

`platform/install.sh` pulls each chart and stops when the registry's digest for the
version differs from the pin. agentgateway is installed from the verified file. The
kagent CLI installs the kagent and Substrate charts by the same versions.

| Chart | Version | Digest | Source |
|---|---|---|---|
| `oci://ghcr.io/kagent-dev/kagent/helm/kagent-crds` | 1.0.0-rc2 | `sha256:6d0a285a230ae08e707eee5faef16dac9a059b120685b64ad38954ac2352bebc` | https://github.com/kagent-dev/kagent/releases/tag/v1.0.0-rc2 |
| `oci://ghcr.io/kagent-dev/kagent/helm/kagent` | 1.0.0-rc2 | `sha256:d8707ae2e9d0f6d2db10a9f2ef0bdbe0e6eb3f8bf5913d820da6b21d58e1ad72` | same (the OCI digest; the release's `.tgz` asset has another SHA-256, which `install.sh` does not compare) |
| `oci://ghcr.io/kagent-dev/substrate/helm/substrate-crds` | 1.0.0-rc2 | `sha256:ef8c8029a32db8cc21b56f60129a8bc594b6532a208bff6ec3a8016dc5a08a2d` | kagent `go/go.mod` at v1.0.0-rc2: `go.ate.dev/substrate => github.com/kagent-dev/substrate v1.0.0-rc2`; also the CLI's default (`kagent config view`) |
| `oci://ghcr.io/kagent-dev/substrate/helm/substrate` | 1.0.0-rc2 | `sha256:c02c1df871f1a41d36c90881508f38be36170eb8cc48a163a3c7ec1508a14fd6` | same |
| `oci://ghcr.io/kagent-dev/substrate/helm/substrate-podcert` | 1.0.0-rc2 | `sha256:730a0b0181fc24cca7feb09154fc085e7001a9dcde2e480a0e997f6ff44b8d70` | same |
| `oci://cr.agentgateway.dev/charts/agentgateway-crds` | v1.6.0 | `sha256:dd7f965d43e54dffa9c95af089b6f762397a23c963a159ad6d4992f6c582292a` | https://agentgateway.dev/docs/kubernetes/latest/install/helm/ (v1.6.0 kept on purpose; v1.7.0 went GA on 2026-10-27 and is what Substrate rc2 bundles as its own gateway) |
| `oci://cr.agentgateway.dev/charts/agentgateway` | v1.6.0 | `sha256:d3edf2b33cbf2e9d59406c207b8d3554597799707b8803b5f62e698fe5376e28` | same |
| `oci://ghcr.io/argoproj/argo-helm/argo-cd` | 10.11.1 (Argo CD v3.5.6) | `sha256:2ac5224a5c201789f96aa9e085673d80732591d1b3e815a8a825a4db6d1d7c88` | https://github.com/argoproj/argo-helm (newest on 2026-10-23, `helm show chart`) |
| Gateway API CRDs `standard-install.yaml` | v1.6.0 | file SHA-256 `a557172e8348f758479e9ee4000bbbb4b4aa48302a6b73461823ea5349bad56d` | https://github.com/kubernetes-sigs/gateway-api/releases/tag/v1.6.0, named by the agentgateway install guide |

## Images

Set by digest in the install values (`versions.env`, applied by `install.sh`). The kagent
chart's image helpers read only `registry`, `repository` and `tag`, so `install.sh` sets the
controller and UI digests on the tag (`image.tag: <version>@sha256:...`). Before the rc2 pin
it set `image.digest`, which the chart ignores (alpha17's too), so those two pins never applied.

| Image | Version | Digest | Source |
|---|---|---|---|
| `ghcr.io/kagent-dev/kagent/controller` | 1.0.0-rc2 | `sha256:1420365cc2dd8f4d37000ddac462b03df38b363f3118d715cb6631c39243f349` | ghcr.io, tag 1.0.0-rc2 |
| `ghcr.io/kagent-dev/kagent/ui` | 1.0.0-rc2 | `sha256:710fe7f2c306ae4e5c010a44b9e44ae4c8f286d31d4a6d1a6d427bb02c40d3e1` | ghcr.io, tag 1.0.0-rc2 |
| `ghcr.io/kagent-dev/substrate/ateworker-gvisor` (WorkerPools `kagent-default` and each team's `team-default`) | v1.0.0-rc2 | `sha256:921de912cd9080bc13e296e5a4f758e59353fdd399d0ae97f32a471c15ccbce9` | ghcr.io; the CLI sets this image by tag, `install.sh` overrides it with the digest (and sets it in the teams chart) |
| `quay.io/argoproj/argocd` (every Argo CD component; `ARGOCD_IMAGE_TAG`) | v3.5.6 | `sha256:8e5cc5bb008df8a09dba439462e58c94c55b7735888d3ebde0c25fc05e4e5335` | the argo-cd chart's appVersion; index digest read on 2026-10-23 with `docker buildx imagetools inspect` |
| `ecr-public.aws.com/docker/library/redis` (Argo CD's cache; `ARGOCD_REDIS_IMAGE_TAG`) | 8.6.4-alpine | `sha256:2cc044fc5a07c9b701f8f1255a309ae9ad7856e694ac03513bf3648c01e40763` | the argo-cd chart's default tag; index digest read on 2026-10-23 |
| `postgres` (kagent's development database) | 18-alpine | `sha256:9a8afca54e7861fd90fab5fdf4c42477a6b1cb7d293595148e674e0a3181de15` | the rc2 CLI's default `install.bundledPostgresImage` (unchanged since alpha17) |

Digest-pinned by the pinned charts themselves:

| Image | Digest | Source |
|---|---|---|
| `ghcr.io/kagent-dev/kagent/golang-adk` (the stock `kagent` runtime) | `sha256:1f2f72c1743dad076beb4a7d12c1d6313f3814ec5ab56204c99783747a8451bc` | kagent chart `files/builtin-harness-images.json` |
| `rustfs/rustfs:1.0.3`, `amazon/aws-cli:2.38.5`, `cr.agentgateway.dev/agentgateway:v1.7.0` (Substrate's egress and router gateway, apart from ours below) | in the substrate chart's `values.yaml` `images:` | substrate chart 1.0.0-rc2 |

Pinned by the chart version's tag, with the digest checked at run time against
`platform/images.lock` (`make status`, line `images`). These charts take one shared
tag and no per-image digest, so this check is detective only: a tag moved upstream is
pulled and runs, and `make status` then reports it as FAIL. It does not stop the
install.

| Image | Version | Digest | Source |
|---|---|---|---|
| `cr.agentgateway.dev/agentgateway` | v1.6.0 | `sha256:9d3e6044ddcdc0878b1787f77bd401252b95e22684203fb5e874c4c42d2ed90c` | cr.agentgateway.dev |
| `cr.agentgateway.dev/controller` | v1.6.0 | `sha256:d84259a7e2d87f8f39bae385d4b032d823c0a4450aecb32e0e31e2258449645b` | cr.agentgateway.dev |
| Substrate control images, kagent-tools, and the rest | see `platform/images.lock` | read from the running pods' `imageID` | the live cluster |

## Token caps

| Part | Version | Digest | Source |
|---|---|---|---|
| `docker.io/envoyproxy/ratelimit`, the image of `platform/ratelimit.yaml` (`RATELIMIT_IMAGE` in `versions.env`; in `images.lock`) | `master` tag, as of 2026-10-24 | `sha256:3d8af7853a9fad2723b2c07f29dd92d416bdfeed50183cf625b210f5115c7e28` (index digest) | https://hub.docker.com/r/envoyproxy/ratelimit, read with `docker buildx imagetools inspect envoyproxy/ratelimit:master`; the project publishes no release tags |
| `docker.io/library/redis`, its counter store (`REDIS_IMAGE` in `versions.env`, same digest as Argo CD's Redis; in `images.lock`) | 8.6.4-alpine | `sha256:2cc044fc5a07c9b701f8f1255a309ae9ad7856e694ac03513bf3648c01e40763` (index digest) | `ARGOCD_REDIS_IMAGE_TAG` in `versions.env` |

## The agent image

| Part | Version | Digest | Source |
|---|---|---|---|
| pnpm in the agent image | the `packageManager` field of `agent/package.json` | none (corepack fetches it at image build) | `agent/package.json`; the Dockerfile runs `corepack install`; https://pnpm.io/ |
| `node` base image of `agent/Dockerfile`, also the image of `platform/demo-mcp.yaml` (`NODE_IMAGE` in `versions.env`; in `images.lock`) | 24-slim | `sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205` (index digest) | https://hub.docker.com/_/node, read on 2026-10-22 with `docker buildx imagetools inspect node:24-slim` |
| `ghcr.io/github/github-mcp-server`, the image of `platform/github-mcp.yaml` (`GITHUB_MCP_IMAGE` in `versions.env`; in `images.lock`) | v2.0.3 | `sha256:250bc6ce70788207608ef74cef4397230ff2e8481218da74d6093e4bd9101132` (index digest) | https://github.com/github/github-mcp-server/releases/tag/v2.0.3, read on 2026-10-22 with `docker buildx imagetools inspect ghcr.io/github/github-mcp-server:v2.0.3` |

The agent's npm dependencies are pinned by `agent/pnpm-lock.yaml`.

## kagent v1.0.0-rc2

rc2 (released 2026-11-04) replaced alpha17 the same day, with the Substrate version it
names (1.0.0-rc2). Neither upgrades in place: Substrate squashed its database migrations
(v0.7.0-alpha2) and changed its snapshot format (rc1), so a cluster built on an older pin
must be rebuilt (`make down && make up`). `install.sh` stops with that message when it finds
a kagent or Substrate release at another version than `versions.env` pins. Source:
[kagent `helm/README.md` at v1.0.0-rc2](https://github.com/kagent-dev/kagent/blob/v1.0.0-rc2/helm/README.md).

On 2026-11-04 `make up` installed rc2 on kind v0.32.0 with `kindest/node:v1.37.0` and the same
kind config (`install.sh` took 229 seconds); `make status`, `make deploy` and `make byo-check` (the starter) passed.
`make smoke` was not run (no model key on that machine).

The install uses the kagent CLI (`kagent install`), the path the 1.x install guide
documents: from 0.6 Substrate needs the PodCertificate controller chart, CA pools, and
a prepared PostgreSQL, which the CLI sets up and a plain Helm install does not.

### Before: kagent v1.0.0-alpha17

On 2026-10-21 `make up` installed alpha17 on kind v0.32.0 with `kindest/node:v1.37.0` and
kagent's kind config (feature gates and `certificates.k8s.io/v1beta1` accepted by Kubernetes
1.37), with Substrate 0.6.0-alpha3, in 138 seconds. kagent's stock agent answered a message
through agentgateway (`make smoke`).
