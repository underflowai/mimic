FROM node:22-slim AS base
RUN apt-get update && apt-get install -y ca-certificates && rm -rf /var/lib/apt/lists/*
RUN corepack enable && corepack prepare pnpm@10.12.1 --activate
WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.json ./
COPY packages/engine/package.json packages/engine/
COPY packages/server/package.json packages/server/
COPY packages/transport-livekit/package.json packages/transport-livekit/
COPY packages/sdk/package.json packages/sdk/

RUN pnpm install --frozen-lockfile

COPY packages/ packages/

EXPOSE 3000
ENV PORT=3000
CMD ["pnpm", "--filter", "@mimic/server", "start"]
