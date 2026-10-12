# syntax=docker/dockerfile:1
FROM node:24-bookworm-slim AS build
WORKDIR /src
RUN corepack enable
COPY . .
RUN pnpm install --frozen-lockfile \
 && pnpm --filter @communal/hub... run build \
 && pnpm --filter @communal/hub deploy --prod /out

FROM node:24-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends tini \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build /out /app
ENV NODE_ENV=production COMMUNAL_HUB_DATA=/data COMMUNAL_HUB_PORT=8443
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 8443/tcp 3478/udp 3479/udp
HEALTHCHECK --interval=10s --timeout=3s --start-period=5s \
  CMD node -e "fetch('http://127.0.0.1:8443/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "/app/dist/main.js"]
