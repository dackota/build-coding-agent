# Pinned versions

The platform scripts read every version and digest below from one file,
`platform/versions.env`. The running images are listed in `platform/images.lock`, and
`make status` fails when a platform pod runs an image that is not in it. Change a pin
only on purpose, and change this page, `versions.env`, and `images.lock` together.

Read on 2026-10-21. Chart digests are what `helm pull` printed; image digests are
index digests from `docker buildx imagetools inspect`, or the `imageID` of the running
pod where noted.

## Tools

| Part | Version | Pin | Source |
|---|---|---|---|
| kind | v0.32.0 | `preflight.sh` refuses another version | https://github.com/kubernetes-sigs/kind/releases/tag/v0.32.0 |
| Helm | major 3 or 4 (4.2.3 used) | `preflight.sh` refuses another major | https://helm.sh/docs/ |
| kagent CLI | v1.0.0-alpha17 | SHA-256 per asset in `versions.env` (darwin-arm64 `2b19bb11...`), checked on download into `.bin/` | https://github.com/kagent-dev/kagent/releases/tag/v1.0.0-alpha17 (asset digests from the release API) |

## Cluster and registry

| Part | Version | Digest | Source |
|---|---|---|---|
| kind node image (Kubernetes 1.37.0) | `kindest/node:v1.37.0` | `sha256:a1ed56cfb0e7b93589bdf97c8cd566405a265939e3620fc4f5de89adff580ae5` | https://hub.docker.com/r/kindest/node/tags; the kagent install guide names `kindest/node:v1.37.0` with kind v0.32.0 |
| kind config | kagent `scripts/kind/kind-config.yaml` | commit `8392184232e9c78196433a34b1fd3b33db5fcb97` (tag v1.0.0-alpha17) | https://github.com/kagent-dev/kagent/blob/v1.0.0-alpha17/scripts/kind/kind-config.yaml |
| Local registry | `registry:2` | `sha256:a3d8aaa63ed8681a604f1dea0aa03f100d5895b6a58ace528858a7b332415373` | https://hub.docker.com/_/registry |
| Smoke image pushed to the registry | `busybox:1.37.0` | `sha256:bdf57e528e45e4433820e045b29b4597825a1c9e38353532d90a01445013f82e` | https://hub.docker.com/_/busybox |

## Charts

`platform/install.sh` pulls each chart and stops when the registry's digest for the
version differs from the pin. agentgateway is installed from the verified file. The
kagent CLI installs the kagent and Substrate charts by the same versions.

| Chart | Version | Digest | Source |
|---|---|---|---|
| `oci://ghcr.io/kagent-dev/kagent/helm/kagent-crds` | 1.0.0-alpha17 | `sha256:c0881dac83bc2a850e70c79d0b0f58f4ac438f8e0c7d8252ce39b5129505619e` | https://github.com/kagent-dev/kagent/releases/tag/v1.0.0-alpha17 |
| `oci://ghcr.io/kagent-dev/kagent/helm/kagent` | 1.0.0-alpha17 | `sha256:aa04bc3c52d31d1860f3229ae5bf208f2c2050a933faf1f506e49fe65e3fbae5` | same |
| `oci://ghcr.io/kagent-dev/substrate/helm/substrate-crds` | 0.6.0-alpha3 | `sha256:f1ddcea3c47f63d08a353e3dbb5ad7bcb94b638394978d64188b846beee90809` | kagent `go/go.mod` at v1.0.0-alpha17: `go.ate.dev/substrate => github.com/kagent-dev/substrate v0.6.0-alpha3`; also the CLI's default (`kagent config view`) |
| `oci://ghcr.io/kagent-dev/substrate/helm/substrate` | 0.6.0-alpha3 | `sha256:8018556e64337dc89da55fb174924a718e0ecd4542e236ffbb61a6e27c72a5e4` | same |
| `oci://ghcr.io/kagent-dev/substrate/helm/substrate-podcert` | 0.6.0-alpha3 | `sha256:e48412f8a88165499e11f590e71920df0437939f284134b5bc0a3cf151d05352` | same |
| `oci://cr.agentgateway.dev/charts/agentgateway-crds` | v1.6.0 | `sha256:dd7f965d43e54dffa9c95af089b6f762397a23c963a159ad6d4992f6c582292a` | https://agentgateway.dev/docs/kubernetes/latest/install/helm/ (v1.6.0 is the newest stable; v1.7.0-alpha.1 is a prerelease) |
| `oci://cr.agentgateway.dev/charts/agentgateway` | v1.6.0 | `sha256:d3edf2b33cbf2e9d59406c207b8d3554597799707b8803b5f62e698fe5376e28` | same |
| Gateway API CRDs `standard-install.yaml` | v1.6.0 | file SHA-256 `a557172e8348f758479e9ee4000bbbb4b4aa48302a6b73461823ea5349bad56d` | https://github.com/kubernetes-sigs/gateway-api/releases/tag/v1.6.0, named by the agentgateway install guide |

## Images

Set by digest in the install values (`versions.env`, applied by `install.sh`):

| Image | Version | Digest | Source |
|---|---|---|---|
| `ghcr.io/kagent-dev/kagent/controller` | 1.0.0-alpha17 | `sha256:d0c5c21998f7492fe42636c9216accc7f263ee3087729989d9b3cb78e427c5f5` | ghcr.io, tag 1.0.0-alpha17 |
| `ghcr.io/kagent-dev/kagent/ui` | 1.0.0-alpha17 | `sha256:68dc2ec374a5250a545b85850b6d284c318e3472c73de6e419e534cdcf5b79a1` | ghcr.io, tag 1.0.0-alpha17 |
| `ghcr.io/kagent-dev/substrate/ateworker-gvisor` (WorkerPool `kagent-default`) | v0.6.0-alpha3 | `sha256:56e6231c3ed48d54afd3068b6313a1545df1277e0ac1faa6090085cc480d573e` | ghcr.io; the CLI sets this image by tag, `install.sh` overrides it with the digest |
| `postgres` (kagent's development database) | 18-alpine | `sha256:9a8afca54e7861fd90fab5fdf4c42477a6b1cb7d293595148e674e0a3181de15` | the alpha17 CLI's default `install.bundledPostgresImage` |

Digest-pinned by the pinned charts themselves:

| Image | Digest | Source |
|---|---|---|
| `ghcr.io/kagent-dev/kagent/golang-adk` (the stock `kagent` runtime) | `sha256:d20d411759d7bb549f00b7d6e8d669b91694aeb57dce847dcd2cbb68aa0d45f3` | kagent chart `files/builtin-harness-images.json` |
| `rustfs/rustfs:1.0.0-beta.3`, `amazon/aws-cli:2.17.0`, `ghcr.io/kagent-dev/substrate/agentgateway` | in the substrate chart's `values.yaml` `images:` | substrate chart 0.6.0-alpha3 |

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

## The agent image

| Part | Version | Digest | Source |
|---|---|---|---|
| pnpm in the agent image | the `packageManager` field of `agent/package.json` | none (corepack fetches it at image build) | `agent/package.json`; the Dockerfile runs `corepack install`; https://pnpm.io/ |
| `node` base image of `agent/Dockerfile` | 24-slim | `sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205` (index digest) | https://hub.docker.com/_/node, read on 2026-10-22 with `docker buildx imagetools inspect node:24-slim` |

The agent's npm dependencies are pinned by `agent/pnpm-lock.yaml`.

## kagent v1.0.0-alpha17

alpha17 (released 2026-10-21) is the version installed, so no fallback to an older
alpha was needed. On 2026-10-21 `make up` installed it on kind v0.32.0 with
`kindest/node:v1.37.0` and kagent's kind config (feature gates and
`certificates.k8s.io/v1beta1` accepted by Kubernetes 1.37), with the Substrate version it
names (0.6.0-alpha3), in 138 seconds. kagent's stock agent answered a message through
agentgateway (`make smoke`).

The install uses the kagent CLI (`kagent install`), the path the 1.x install guide
documents: from 0.6 Substrate needs the PodCertificate controller chart, CA pools, and
a prepared PostgreSQL, which the CLI sets up and a plain Helm install does not. The
guide names alpha16; alpha17 came out the same day as this pin.
