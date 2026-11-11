# syntax=docker/dockerfile:1
FROM golang:1.27-alpine AS log-build
ENV GOMAXPROCS=2
WORKDIR /log-src
COPY utils/logging/ ./
RUN --mount=type=cache,target=/root/.cache/go-build CGO_ENABLED=0 go test ./... && CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /logrunner .

FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci --ignore-scripts --no-audit --no-fund
COPY tsconfig.json tsconfig.build.json tsconfig.browser.json ./
COPY shared ./shared
COPY services/backend ./services/backend
COPY utils/scripts ./utils/scripts
COPY utils/stress ./utils/stress
RUN npm run build && npm prune --omit=dev --ignore-scripts --no-audit --no-fund

# Keep benchmark orchestration out of the application image.
FROM build AS production-build
RUN rm -rf /app/dist/utils/stress /app/dist/utils/scripts/stress-gateway.js

FROM node:22-alpine AS runtime-base
WORKDIR /app
COPY package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=production-build /app/dist ./
COPY services/backend/src/views ./services/backend/src/views
COPY services/backend/src/public ./services/backend/src/public
COPY services/backend/migrations ./services/backend/migrations
COPY --from=log-build /logrunner /usr/local/bin/logrunner
ENTRYPOINT ["/usr/local/bin/logrunner"]
USER node
EXPOSE 3000
CMD ["node","services/backend/src/server.js"]

# Explicit opt-in target used only by the isolated Docker test harness.
FROM runtime-base AS load-test
COPY --from=build /app/dist/utils/stress ./utils/stress
COPY --from=build /app/dist/utils/scripts/stress-gateway.js ./utils/scripts/stress-gateway.js

# The default build remains the lean application image.
FROM runtime-base AS runtime
