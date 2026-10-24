# The byo TypeScript starter. Node 24 runs the TypeScript source directly (type stripping).
# Base pinned by index digest, the same one as the platform's coding agent (agent/Dockerfile).
FROM node:24-slim@sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205

WORKDIR /app
COPY package.json pnpm-lock.yaml ./
RUN corepack enable && corepack install -g "$(node -p 'require("./package.json").packageManager')" && pnpm install --frozen-lockfile --prod
COPY src ./src

# Explicit entrypoint: the Harness sets no command, so this is what runs. The contract is
# A2A over gRPC on 0.0.0.0:80 and /readyz on 8081 (docs/byo-contract.md).
ENTRYPOINT ["node", "/app/src/main.ts"]
