FROM node:24.18-bookworm-slim AS dependencies

ENV NEXT_TELEMETRY_DISABLED=1
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci \
    && npm cache clean --force


FROM node:24.18-bookworm-slim AS builder

ENV NEXT_TELEMETRY_DISABLED=1
WORKDIR /app

COPY --from=dependencies /app/node_modules ./node_modules
COPY package.json package-lock.json next.config.ts next-env.d.ts tsconfig.json ./
COPY src ./src

RUN npm run build


FROM node:24.18-bookworm-slim AS production

LABEL org.opencontainers.image.source="https://github.com/fbsis/safer-notes"

ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    HOSTNAME=0.0.0.0 \
    PORT=3001 \
    NOTES_DB=/app/data/notes.sqlite \
    NOTES_HTTPS=0 \
    NOTES_IDLE_MINUTES=15 \
    NOTES_MAX_NOTE_MB=50

WORKDIR /app

COPY --from=builder --chown=node:node /app/.next/standalone ./
COPY --from=builder --chown=node:node /app/.next/static ./.next/static
COPY --chmod=755 docker-entrypoint.sh /app/docker-entrypoint.sh

RUN mkdir -p /app/data \
    && chown node:node /app/data \
    && chmod 700 /app/data

EXPOSE 3001

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:3001/api/status').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]

ENTRYPOINT ["/app/docker-entrypoint.sh"]
CMD ["node", "server.js"]
