# Deployments

One folder per agent: `deployments/<team>/<agent>/values.yaml`. Argo CD watches this
folder on `main`. Merge a folder and the agent deploys into namespace `team-<team>`;
delete the folder and Argo CD removes it. Nobody applies anything by hand. Within about a
minute of the agent's registration appearing, the platform's minter gives it its own model
key (Secret `<agent>-agent-key`, which no one needs to read); deleting the folder removes
the key too.

The team must be on the team list, `platform/teams.txt`. The values file must match the
schema in `platform/charts/agent/values.schema.json`, which rejects unknown fields. The
folder's name must be the agent's `name`, and its parent folder the agent's `team`.

Three runtimes deploy today: `stock` (kagent's built-in runtime: a prompt, catalog tools and
subagents) and `coding` (the platform's coding agent from `agent/`: file tools, `bash` with
approvals, subagents, skills, and `/implement`; it also reaches GitHub and npm). `byo` runs your own image: set `image` (pinned by digest, from the allowed registry) and
`command`; the image must meet the rules in
[docs/byo-contract.md](../docs/byo-contract.md), and `make byo-push` prints the `image` line.

```yaml
name: my-agent
team: platform
owner: your-github-handle
description: Answers questions briefly
runtime: coding           # or stock, or byo (see above)
model: glm-5.3-flash      # a platform model name
systemPrompt: You are a concise coding agent. Reply briefly.
tokenCap: 1000000         # monthly tokens, at most 50000000
subagents: [explorer, executor, reviewer]   # any of these, by name
tools:                    # catalog tools, by name
  - github-read           # issue_read; add requireApproval: true to pause on it
  - github-write          # create_branch, push_files, create_pull_request; always pauses for approval
skills: [docs-style]      # skills from platform/skills/
```

`demo-delete-branch` is a third catalog tool, a fake `delete_branch` that shows approvals.
A write tool always pauses for a human's approval: the schema refuses `requireApproval: false`
on one. The platform team's own agents are examples: `deployments/platform/hello-agent`
(coding, write tools, all three subagents), `docs-agent` (coding, a skill) and
`triage-agent` (stock, `github-read`).

Check a file before you open the pull request:

```sh
helm template my-agent platform/charts/agent -n team-platform -f deployments/platform/my-agent/values.yaml
```

With `skills`, also pass a stand-in for the image pin Argo CD adds (`make deploy` builds the
real one): `--set platform.skillImages.docs-style=r/s@sha256:$(printf '0%.0s' {1..64})`.
`runtime: coding` agents answer once `make deploy` has pinned the coding image.

After the merge, talk to it: `make chat TEAM=platform AGENT=my-agent MSG="hello"`.

To try a folder before merge, push it on a branch and run `GITOPS_REVISION=<branch> make up`
(on a fresh cluster, or rerun it on one that is up); Argo CD then tracks that branch.
