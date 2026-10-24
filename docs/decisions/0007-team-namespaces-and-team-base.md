# 0007: One namespace per team, and a platform-owned team base

Status: accepted, 2026-10-24 (golden path, spec #49, tickets 52, 53).

## Context

kagent finds a Harness, ModelConfig, RemoteMCPServer, EgressPolicy or subagent template only in
the agent's own namespace. Teams must not read each other's keys or change shared pieces.

## Decision

Each team on `platform/teams.txt` gets namespace `team-<team>`, made by the platform. The
platform puts its own copy of the team base in each: WorkerPool and ServiceAccount
`team-default`, `default-model-config`, Harness `kagent-stock`, Harness `coding`, the subagent
templates, and the git and npm EgressPolicies. A per-team Argo CD AppProject allows this repo,
that namespace, and no cluster-scoped kinds. Teams cannot change the base.

## Option that lost

**One shared namespace for every team.** It was the earlier layout. It needs no copies,
but every team's agents, keys and Secrets share one trust wall, and one team's mistake can
reach another's. The namespace is the unit kagent and Substrate treat as the trust wall, so
the golden path moved onto it and deleted the shared one.

## Consequences

- Adding a team means adding a line to `platform/teams.txt` and a cluster rebuild, because
  Substrate's credential provider namespace lists come from the team list and the install skips
  installed releases.
- `make deploy` pins the `coding` image by digest in each team's Harness; that digest is per
  build and is not in git.
