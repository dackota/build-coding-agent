# The coding agent image. Node 24 runs the TypeScript source directly (type stripping).
# Base pinned by index digest (see docs/pinned-versions.md).
FROM node:24-slim@sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205

# git and pnpm sit next to node so the agent can build a real project. corepack fetches pnpm
# at build time, globally, at the version package.json names (packageManager): the actor has no network, and runs
# commands outside /app, where that file is not found.
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json pnpm-lock.yaml ./
RUN corepack enable && corepack install -g "$(node -p 'require("./package.json").packageManager')" && pnpm install --frozen-lockfile --prod
COPY src ./src
# Session state (pending pauses) lives here; an actor snapshot keeps it across suspend and wake.
RUN mkdir -p /data
ENV AGENT_DATA_DIR=/data

# Explicit entrypoint: kagent's byo contract is A2A over gRPC on 127.0.0.1:80 and /readyz on 8081.
ENTRYPOINT ["node", "/app/src/main.ts"]
