# syntax=docker/dockerfile:1
FROM node:24-bookworm-slim AS build
WORKDIR /src
RUN corepack enable
COPY . .
RUN pnpm install --frozen-lockfile \
 && pnpm --filter @communal/cli... --filter @communal/spike-transport... run build \
 && pnpm --filter @communal/cli deploy --prod /out/cli \
 && pnpm --filter @communal/spike-transport deploy --prod /out/spike

FROM node:24-bookworm-slim
# ffmpeg and sharp's native deps are added with the thumbnail pipeline (M6).
RUN apt-get update && apt-get install -y --no-install-recommends tini \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build /out /app
RUN printf '#!/bin/sh\nexec node /app/cli/dist/main.js "$@"\n' > /usr/local/bin/communal \
 && printf '#!/bin/sh\nexec node /app/spike/dist/bench.js "$@"\n' > /usr/local/bin/communal-spike \
 && chmod +x /usr/local/bin/communal /usr/local/bin/communal-spike \
 && mkdir -p /var/lib/communal && chown node:node /var/lib/communal
ENV NODE_ENV=production COMMUNAL_DATA=/var/lib/communal
USER node
VOLUME /var/lib/communal
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["communal", "daemon"]
