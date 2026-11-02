# syntax=docker/dockerfile:1
FROM node:22-slim AS build
RUN corepack enable
WORKDIR /app
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json tsconfig.base.json ./
COPY packages ./packages
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @crmemory/shared build && pnpm --filter @crmemory/server build
RUN pnpm --filter @crmemory/server deploy --legacy --prod /out

FROM node:22-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /out ./
USER node
EXPOSE 8787
# Applies pending migrations, then starts the role set by CRMEMORY_ROLE.
CMD ["sh", "-c", "node dist/db/migrate.js && node dist/index.js"]
