FROM node:24.18-bookworm-slim AS dependencies

WORKDIR /build

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts \
    && npm cache clean --force


FROM node:24.18-bookworm-slim AS production

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3001 \
    NOTES_DB=/app/data/notes.sqlite \
    NOTES_HTTPS=0

WORKDIR /app

COPY --from=dependencies --chown=node:node /build/node_modules ./node_modules
COPY --chown=node:node package.json package-lock.json ./
COPY --chown=node:node notes ./notes

RUN mkdir -p /app/data \
    && chown node:node /app/data \
    && chmod 700 /app/data

USER node

EXPOSE 3001

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:3001/api/status').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]

CMD ["node", "notes/notes.js"]
