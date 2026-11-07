# syntax=docker/dockerfile:1
# The build stage runs natively once, even for multi-arch images: its output
# is plain JavaScript with no native modules, so it is the same on every arch.
FROM --platform=$BUILDPLATFORM node:22-slim AS build
RUN corepack enable
WORKDIR /app
COPY pnpm-lock.yaml pnpm-workspace.yaml .pnpmfile.cjs package.json tsconfig.base.json ./
COPY packages ./packages
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @retainer/shared build && pnpm --filter @retainer/sdk build && pnpm --filter @retainer/web build && pnpm --filter @retainer/server build
RUN pnpm --filter @retainer/server deploy --legacy --prod /out

FROM node:22-slim
ENV NODE_ENV=production
ENV RETAINER_WEB_DIR=/app/web
WORKDIR /app
COPY --from=build /out ./
COPY --from=build /app/packages/web/dist ./web
# The operator CLI (ARCHITECTURE.md 7.1):
#   docker compose exec retainer retainer workspace create --name "Acme"
RUN printf '#!/bin/sh\nexec node /app/dist/cli.js "$@"\n' > /usr/local/bin/retainer \
  && chmod +x /usr/local/bin/retainer
USER node
EXPOSE 8787
# Applies pending migrations, then starts the role set by RETAINER_ROLE.
CMD ["sh", "-c", "node dist/db/migrate.js && node dist/index.js"]
