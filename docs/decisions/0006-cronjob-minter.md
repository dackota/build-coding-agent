# 0006: A CronJob minter, an operator later

Status: accepted, 2026-10-24 (golden path, spec #49, tickets 53, 54, 55, 56).

## Context

Something must turn each agent's registration into its key, cap and tool policy, and remove
them when the agent goes. It needs write access to Secrets and to agentgateway's config, so
it must be small and narrowly scoped.

## Decision

The minter is a TypeScript CronJob in `platform-system`, run every minute from
`agent/src/minter/`. Its core is a pure function, `plan(registrations, teams, current, newKey, budgets)`
that returns changes; a thin Kubernetes adapter reads the inputs and applies them. It owns the
key Secret, the key hash, the ratelimit entries, and the tool policy per agent. Its RBAC is
scoped to exactly those writes.

## Option that lost

**A real operator now** (a watch loop with leader election, perhaps kubebuilder). Changes
would apply in seconds, but it is a new codebase, a controller image, and leader election to
run for a platform whose changes already land within a minute. The pure `plan()` core moves
into an operator unchanged. See [the Later list](../later.md).

## Consequences

- A new or changed agent waits up to a minute for its key.
- A run that fails changes nothing it did not plan; the next run, a minute later, plans again
  from what it reads.
