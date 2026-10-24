# 0004: The values-file chart is the contract between a team and the platform

Status: accepted, 2026-10-24 (golden path, spec #49).

## Context

A team needs to ship an agent without learning kagent. kagent is an alpha
(1.0.0-alpha17): its `v1alpha3` kinds change between releases, and one wrong field in a
hand-written Agent, Harness or EgressPolicy can widen what an agent reaches.

## Decision

One values file per agent, `deployments/<team>/<agent>/values.yaml`. A Helm chart
(`platform/charts/agent`) renders it into the kagent objects, a registration ConfigMap and
the rest. A strict JSON schema refuses unknown fields. Argo CD deploys it, and each team's
AppProject allows only the kinds the chart renders. When kagent changes, the chart changes,
not every team's file.

## Option that lost

**Teams hand-write kagent YAML in their own folder.** It is what the repo did before (the
single shared namespace of the first layout). It ties every team to alpha API shapes, and a team could write any
field, including ones that switch a guard rail off. It also needs a rule per kind in review.

## Consequences

- A team cannot use a kagent feature the schema does not name. The platform adds the field.
- The `runtime` field (`stock`, `coding`, `byo`) picks how the agent runs; the kagent object is
  still called the Harness.
