# Bun 1.4.0 on Debian slim, pinned by digest. Update the tag and digest together.
ARG BUN_IMAGE=oven/bun:1.4.0-slim@sha256:e0ee68d16ccb9927bf02aa7dd8fd4bf3369ee6d46da04faa72b05ce8bfd135f6

FROM ${BUN_IMAGE} AS build
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY . .
RUN bun run build

FROM ${BUN_IMAGE} AS dependencies
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

FROM ${BUN_IMAGE} AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    POSTREEVE_HOST=0.0.0.0 \
    PORT=3000 \
    POSTREEVE_DB_PATH=/app/data/postreeve.sqlite
COPY --from=dependencies /app/node_modules ./node_modules
COPY package.json tsconfig.json ./
COPY src/server ./src/server
COPY src/shared ./src/shared
COPY scripts/backup.ts ./scripts/backup.ts
COPY --from=build /app/dist ./dist
COPY --chmod=755 deploy/docker-entrypoint.sh /usr/local/bin/postreeve-entrypoint
RUN install -d -o bun -g bun -m 700 /app/data
VOLUME ["/app/data"]
EXPOSE 3000
# The probe uses loopback, which the server's host check always accepts.
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD ["bun", "-e", "fetch('http://127.0.0.1:' + (process.env.PORT || 3000) + '/api/health').then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
# The entrypoint fixes volume ownership as root, then runs the server as the unprivileged bun user.
ENTRYPOINT ["postreeve-entrypoint"]
CMD ["bun", "src/server/index.ts"]
