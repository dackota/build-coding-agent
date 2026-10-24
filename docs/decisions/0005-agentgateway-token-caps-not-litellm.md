# 0005: Token caps at agentgateway, not LiteLLM

Status: accepted, 2026-10-24 (golden path, spec #49, ticket 54).

## Context

Each agent and each team needs a monthly cap on model tokens, and the call must be refused
past it. The model is a flat OpenCode Go plan, so the limit that matters is usage, in tokens,
not dollars. agentgateway already sits in front of the model.

## Decision

agentgateway global rate limiting, backed by Envoy's `ratelimit` service and Redis, counts
tokens. Each call is checked against two descriptors: the agent's and its team's. The minter
writes both into the ratelimit config. Past either, the call gets HTTP 429. Team budgets sit
in `platform/budgets.txt`, outside the deployments folders a team can edit.

## Option that lost

**LiteLLM as the model proxy with budgets.** It has budgets and keys built in. The repo owner
does not trust it after its recent CVEs, and it would be a second proxy next to agentgateway,
holding the provider key. Keeping one proxy keeps one place that holds the key.

## Consequences

- The window is the service's month, 30 days, not a calendar month.
- A changed cap takes a few minutes: the minter runs each minute, then the ratelimit service
  reloads. `make status` shows use against each cap.
- Redis holds the counters (Redis and the ratelimit service run in `agentgateway-system`).
