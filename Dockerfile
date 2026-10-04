FROM node:24-bookworm-slim AS build
WORKDIR /source
COPY . .
RUN npm --prefix ui ci --ignore-scripts --no-audit --no-fund && npm run build:ui
RUN rm -rf ui/node_modules ui/.svelte-kit

FROM node:24-bookworm-slim
WORKDIR /app
COPY --from=build --chown=node:node /source/ .
RUN mkdir -p /app/data && chown node:node /app/data && chmod 700 /app/data
USER node
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000 DATA_DIR=/app/data
EXPOSE 3000
VOLUME ["/app/data"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 CMD ["node", "scripts/healthcheck.mjs"]
CMD ["node", "server/index.mjs"]
