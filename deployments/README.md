# Deployments

One folder per agent: `deployments/<team>/<agent>/values.yaml`. Argo CD watches this
folder on `main`. Merge a folder and the agent deploys into namespace `team-<team>`;
delete the folder and Argo CD removes it. Nobody applies anything by hand.

The team must be on the team list, `platform/teams.txt`. The values file must match the
schema in `platform/charts/agent/values.schema.json`, which rejects unknown fields. The
folder's name must be the agent's `name`, and its parent folder the agent's `team`.

Only `runtime: stock` (kagent's built-in runtime) deploys today:

```yaml
name: my-agent
team: platform
owner: your-github-handle
description: Answers questions briefly
runtime: stock
model: glm-5.3-flash      # a platform model name
systemPrompt: You are a concise, helpful assistant. Reply briefly.
tokenCap: 1000000         # monthly tokens, at most 50000000
```

Check a file before you open the pull request:

```sh
helm template my-agent platform/charts/agent -n team-platform -f deployments/platform/my-agent/values.yaml
```

After the merge, talk to it: `make chat TEAM=platform AGENT=my-agent MSG="hello"`.

To try a folder before merge, push it on a branch and run `GITOPS_REVISION=<branch> make up`
(on a fresh cluster, or rerun it on one that is up); Argo CD then tracks that branch.
