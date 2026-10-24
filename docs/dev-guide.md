# Ship an agent

How a team puts an agent on the platform: one values file, one pull request. You never write
kagent YAML and never touch a credential.

## 1. Get on the team list

Your team must be named in `platform/teams.txt`, and have a monthly token budget in
`platform/budgets.txt`. The platform team owns both. The team gets namespace `team-<team>`
and its [team base](GLOSSARY.md). A team with no budget gets no keys.

## 2. Write the values file

Create `deployments/<team>/<agent>/values.yaml`. The folder is the agent's `name`, its parent
the `team`.

```yaml
name: my-agent
team: platform
owner: your-github-handle
description: Answers questions briefly
runtime: coding           # stock, coding, or byo
model: glm-5.3-flash      # a platform model name
systemPrompt: You are a concise coding agent. Reply briefly.
tokenCap: 1000000         # monthly tokens, at most 50000000
subagents: [explorer, executor, reviewer]
tools:
  - github-read
  - github-write
github:
  repos: [your-org/your-repo]   # the repos github-write may change
```

Pick a runtime:

- `stock`: kagent's built-in runtime. A prompt, catalog tools and subagents, no code.
- `coding`: the platform's coding agent (file tools, `bash` with approvals, skills, `/implement`).
- `byo`: your own image, pinned by digest. Follow [the byo contract](byo-contract.md), start from
  `templates/byo-ts`, push with `make byo-push`, and check with `make byo-check`.

Every field is in [deployments/README.md](../deployments/README.md). The schema
(`platform/charts/agent/values.schema.json`) refuses unknown fields.

## 3. Check it, then open the pull request

```sh
helm template my-agent platform/charts/agent -n team-platform -f deployments/platform/my-agent/values.yaml
```

## 4. Merge, and talk to it

On merge, Argo CD deploys the agent into `team-<team>`. Within about a minute the platform's
minter gives it a model key, a token cap inside your team's budget, and a tool policy at the
gateway. Then:

```sh
make chat TEAM=platform AGENT=my-agent MSG="hello"
```

Delete the folder and Argo CD removes the agent; the minter removes its key, cap and policy.

## What you cannot change

The [guard rails](guard-rails.md) hold for every agent, `byo` included: your key, your caps,
your tool list, and your repo list. To change one, ask the platform team. To add a tool, model
or host to the catalog, see [building on the platform](building-on-the-platform.md).
