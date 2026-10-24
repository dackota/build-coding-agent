# Later

What the golden path leaves out on purpose, and why. Each item is a bigger piece than the
platform needs to be useful today.

- **A real operator in place of the minter CronJob.** Why: the CronJob runs each minute, so a
  new key, cap or tool policy takes up to a minute to apply; a watch loop with leader election
  would make it seconds, and is worth building when that wait hurts. See
  [ADR 0006](decisions/0006-cronjob-minter.md).
- **cosign signatures checked by Kyverno on Harness objects.** Why: today a `byo` image is
  trusted by a registry allow list and a digest pin; a signature would prove who built it. The
  check must target Harness objects, because Substrate's atelet pulls images and the kubelet
  never sees them, so a Pod admission check would not fire.
- **A GitHub App in place of the one platform token.** Why: the token is held at the gateway
  but is still one credential for every agent; an App would give each call a short-lived,
  repo-scoped token.
- **Evals.** Why: nothing yet measures whether an agent's answers or pull requests are good, so a
  prompt or model change is judged by hand.
- **Observability.** Why: logs and `make status` show use against caps, but there are no traces
  or per-agent dashboards for latency, errors or spend.
- **A2A between agents.** Why: kagent alpha17 has no agent-as-tool field and an actor may not
  call another session; see [ADR 0003](decisions/0003-a2a-and-stock-runtime.md).
