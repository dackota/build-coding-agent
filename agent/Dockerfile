# The coding agent image. Node 24 runs the TypeScript source directly (type stripping).
# Base pinned by index digest (see docs/pinned-versions.md).
FROM node:24-slim@sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205

RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json pnpm-lock.yaml ./
RUN corepack enable && pnpm install --frozen-lockfile --prod
COPY src ./src

# Explicit entrypoint: kagent's byo contract is A2A over gRPC on 127.0.0.1:80 and /readyz on 8081.
ENTRYPOINT ["node", "/app/src/main.ts"]
