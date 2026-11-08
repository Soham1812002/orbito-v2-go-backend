# syntax=docker/dockerfile:1
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci --ignore-scripts --no-audit --no-fund
COPY tsconfig.json tsconfig.build.json tsconfig.browser.json ./
COPY shared ./shared
COPY services/backend ./services/backend
COPY utils/scripts ./utils/scripts
RUN npm run build && npm prune --omit=dev --ignore-scripts --no-audit --no-fund

FROM node:22-alpine AS runtime
WORKDIR /app
COPY package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./
COPY services/backend/src/views ./services/backend/src/views
COPY services/backend/src/public ./services/backend/src/public
COPY services/backend/migrations ./services/backend/migrations
USER node
EXPOSE 3000
CMD ["node","services/backend/src/server.js"]
