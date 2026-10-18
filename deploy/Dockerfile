FROM node:24.18.1-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY web ./web
COPY public ./public
COPY scripts/build.js ./scripts/build.js
RUN npm run build && npm prune --omit=dev

FROM node:24.18.1-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends python3 coreutils ca-certificates \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node package.json package-lock.json ./
COPY --chown=node:node src ./src
COPY --chown=node:node migrations ./migrations
COPY --chown=node:node scripts ./scripts
USER node
EXPOSE 3000
CMD ["node", "src/app/server.js"]
