# build-coding-agent

A coding agent in TypeScript, built by following the
[Vercel AI agent harness course](https://vercel.com/academy/build-ai-agent-harness).
It runs as a kagent 1.x `byo` agent on Agent Substrate, on a local kind cluster.

The plan is in the spec issue.

## Local platform

Needs Docker, kind v0.32.0, kubectl, Helm, jq, curl, shasum, and git. Copy `.env.example` to `.env`
and set `OPENCODE_KEY`, then:

```sh
make up       # kind cluster, local registry, Substrate, kagent, agentgateway
make status   # ok or FAIL per part
make smoke    # registry digest in a Harness, and one message to kagent's stock agent
make deploy   # build the agent image, push it, apply Harness and Agent by digest
make chat MSG="What is 7 times 6?"   # one message through the kagent controller
make chat MSG="Make the button a nicer colour"   # may pause with a question; answer it as agent/README.md says
make chat FILE=greet.js MSG="rename function foo to bar"   # prints the reply and a unified diff
make down     # remove the cluster and the registry
```

The agent is in `agent/` (see `agent/README.md`). See `platform/README.md`, and `docs/pinned-versions.md` for every pinned version.

## Secrets

This repo is public. Never commit keys, tokens, or `.env`.
Run `pre-commit install` once. The gitleaks hook blocks commits that hold a secret.
