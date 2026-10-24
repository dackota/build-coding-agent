# build-coding-agent

A coding agent written in TypeScript. You send it a task. It reads and edits code in its
own workspace, runs commands, and can open a pull request on GitHub. It pauses to ask
you before it does anything risky.

It runs as a kagent 1.x `byo` ("bring your own image") agent on Agent Substrate, on a
local kind cluster. It follows the
[Vercel AI agent harness course](https://vercel.com/academy/build-ai-agent-harness).

## Quick start

You need Docker, kind v0.32.0, kubectl, Helm 3 or 4, jq, curl, shasum, git, Node 24, and pnpm.

1. Copy `.env.example` to `.env` in the main checkout (worktrees share it).
2. Set `OPENCODE_KEY` (the model key) and `GITHUB_TOKEN` (a fine-grained token for the
   repos the agent may push to; each agent is held to its own `github.repos` list at the
   gateway).
3. Run:

```sh
make up        # create the cluster and install everything (safe to run again)
make status    # one ok or FAIL line per part
make deploy    # build the agent image and run it on the cluster
make chat MSG="What is 7 times 6?"
```

`make down` deletes the cluster and the registry. `make help` lists every target.

## What to read next

| I want to... | Read |
|---|---|
| Understand the pieces and how a message flows | [docs/how-it-works.md](docs/how-it-works.md) |
| Talk to the agent, answer its questions, approve commands | [docs/using-the-agent.md](docs/using-the-agent.md) |
| Turn a GitHub issue into a pull request (`/implement`) | [docs/implement-loop.md](docs/implement-loop.md) |
| Ship an agent from a values file (start here if you are a team) | [docs/dev-guide.md](docs/dev-guide.md) |
| See what the platform holds in place for every agent, and the proof | [docs/guard-rails.md](docs/guard-rails.md) |
| Bring my own agent image | [docs/byo-contract.md](docs/byo-contract.md) |
| Every field of a values file | [deployments/README.md](deployments/README.md) |
| See what is left for later, and why | [docs/later.md](docs/later.md) |
| Add a catalog tool, model, subagent, or egress host (platform team) | [docs/building-on-the-platform.md](docs/building-on-the-platform.md) |
| Add a tool or a tool policy in code | [docs/extensions.md](docs/extensions.md) |
| Find my way around the agent code, run the tests | [agent/README.md](agent/README.md) |
| Change or debug the cluster setup | [platform/README.md](platform/README.md) |
| Look up a term | [docs/GLOSSARY.md](docs/GLOSSARY.md) |
| See why a big choice was made | [docs/decisions/](docs/decisions/) |
| See or change a pinned version | [docs/pinned-versions.md](docs/pinned-versions.md) |

## Secrets

This repo is public. Never commit keys, tokens, or `.env`.
Run `pre-commit install` once. Its gitleaks hook blocks a commit that holds a secret.
