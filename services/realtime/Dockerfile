# syntax=docker/dockerfile:1
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci --ignore-scripts --no-audit --no-fund
COPY tsconfig.json tsconfig.build.json tsconfig.browser.json ./
COPY shared ./shared
COPY services/realtime ./services/realtime
RUN npx tsc -p tsconfig.build.json && npm prune --omit=dev --ignore-scripts --no-audit --no-fund

FROM node:22-alpine AS runtime
WORKDIR /app
COPY package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./
USER node
EXPOSE 3001
CMD ["node","services/realtime/src/server.js"]
