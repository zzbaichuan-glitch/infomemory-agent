# syntax=docker/dockerfile:1
FROM node:24-bookworm-slim AS build

WORKDIR /workspace

COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/package.json
COPY packages/core/package.json packages/core/package.json
RUN npm ci --registry=https://registry.npmjs.org

COPY tsconfig.base.json ./
COPY apps/api/tsconfig.json apps/api/tsconfig.json
COPY packages/core/tsconfig.json packages/core/tsconfig.json
COPY apps/api/src apps/api/src
COPY packages/core/src packages/core/src

RUN npm run build && npm prune --omit=dev

FROM node:24-bookworm-slim AS runtime

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    DATABASE_PATH=/app/var/infomemory.sqlite \
    AUTH_MODE=bearer

WORKDIR /app

COPY --from=build --chown=node:node /workspace/package.json /workspace/package-lock.json ./
COPY --from=build --chown=node:node /workspace/node_modules ./node_modules
COPY --from=build --chown=node:node /workspace/apps/api/package.json apps/api/package.json
COPY --from=build --chown=node:node /workspace/apps/api/dist apps/api/dist
COPY --from=build --chown=node:node /workspace/packages/core/package.json packages/core/package.json
COPY --from=build --chown=node:node /workspace/packages/core/dist packages/core/dist
COPY --chown=node:node docs/api docs/api

RUN mkdir -p /app/var && chown node:node /app/var

USER node
EXPOSE 3000
VOLUME ["/app/var"]

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:3000/health/live').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]

CMD ["node", "apps/api/dist/server.js"]
