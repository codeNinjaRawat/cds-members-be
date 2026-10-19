# The API and the worker (same image, different command). Build from the membership folder – the API reads the shared
# contracts in admin/src/lib (zod schemas used by the website, the admin and the API):
#   docker build -f BE/Dockerfile -t membership-api .
#   docker run --env-file BE/.env -p 4330:4330 membership-api                 # the API
#   docker run --env-file BE/.env membership-api npm run worker               # the worker (jobs + outbox)
FROM node:22-alpine
WORKDIR /srv
ENV NODE_ENV=production
# contracts first (they change less often than the API)
COPY admin/src/lib ./admin/src/lib
COPY BE/package.json BE/package-lock.json* ./BE/
RUN cd BE && (npm ci --omit=dev --include=optional || npm install --omit=dev) && npm install --no-save tsx@4 typescript@5 zod@3
COPY BE ./BE
WORKDIR /srv/BE
# the admin contracts import zod from their own folder – make it resolvable there too
RUN mkdir -p /srv/admin/node_modules && ln -s /srv/BE/node_modules/zod /srv/admin/node_modules/zod
USER node
EXPOSE 4330
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:${PORT:-4330}/health || exit 1
CMD ["npx", "tsx", "src/http/server.ts"]
