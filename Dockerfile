# The API and the worker (same image, different command). Build from the membership folder – the API reads the shared
# contracts in admin/src/lib (zod schemas used by the website, the admin and the API):
#   docker build -f BE/Dockerfile -t membership-api .
#   docker compose -f BE/deploy/docker-compose.prod.yml up -d          (server: API + worker, settings in BE/.env.production)
# pm2 without Docker is the other way: BE/deploy/README.md.
FROM node:22-alpine
WORKDIR /srv
ENV NODE_ENV=production
RUN apk add --no-cache tini
# contracts first (they change less often than the API)
COPY admin/src/lib ./admin/src/lib
COPY BE/package.json BE/package-lock.json* ./BE/
RUN cd BE && (npm ci --omit=dev --no-audit --no-fund || npm install --omit=dev --no-audit --no-fund) && npm cache clean --force
COPY BE/src ./BE/src
COPY BE/sql ./BE/sql
COPY BE/deploy ./BE/deploy
WORKDIR /srv/BE
# the admin contracts import zod from their own folder – make it resolvable there too
RUN mkdir -p /srv/admin/node_modules && ln -s /srv/BE/node_modules/zod /srv/admin/node_modules/zod \
 && mkdir -p /srv/files && chown node:node /srv/files
USER node
EXPOSE 4330
HEALTHCHECK --interval=30s --timeout=3s --start-period=20s CMD wget -qO- http://127.0.0.1:${PORT:-4330}/health >/dev/null || exit 1
# tini forwards SIGTERM so the API can finish open requests on an update
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "--import", "tsx", "src/http/server.ts"]
