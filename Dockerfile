FROM oven/bun:1.4.0 AS build
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY . .
RUN bun run build

FROM oven/bun:1.4.0 AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    POSTREEVE_HOST=0.0.0.0 \
    PORT=3000 \
    POSTREEVE_DB_PATH=/app/data/postreeve.sqlite
COPY --from=build /app/package.json /app/bun.lock ./
RUN bun install --frozen-lockfile --production
COPY --from=build /app/dist ./dist
COPY --from=build /app/src ./src
RUN install -d -o bun -g bun /app/data
VOLUME ["/app/data"]
EXPOSE 3000
USER bun
CMD ["bun", "src/server/index.ts"]
