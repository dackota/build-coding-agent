# build-coding-agent

A coding agent in TypeScript, built by following the
[Vercel AI agent harness course](https://vercel.com/academy/build-ai-agent-harness).
It runs as a kagent 1.x `byo` agent on Agent Substrate, on a local kind cluster.

The plan is in the spec issue.

## Secrets

This repo is public. Never commit keys, tokens, or `.env`.
Run `pre-commit install` once. The gitleaks hook blocks commits that hold a secret.
