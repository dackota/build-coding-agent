# The byo contract checker (agent/src/byo-check). platform/byo-check.sh assembles the build
# context: the starter's package.json and lockfile (the same dependencies), the checker's
# source and the task store codecs it shares with the agent.
# Base pinned by index digest, the same one as the starter (templates/byo-ts/Dockerfile).
FROM node:24-slim@sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205

WORKDIR /app
COPY package.json pnpm-lock.yaml ./
RUN corepack enable && corepack install -g "$(node -p 'require("./package.json").packageManager')" && pnpm install --frozen-lockfile --prod
COPY src ./src

ENTRYPOINT ["node", "/app/src/byo-check/run.ts"]
