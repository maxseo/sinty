# Build on the TARGET Linux platform: never COPY a Windows build/stage/node_modules.
ARG NODE_IMAGE=node:24.22.1-bookworm-slim@sha256:be8204d4bd327363357f532187b752ff62759c31bedf98e9e18fc08c9cbd605c
FROM ${NODE_IMAGE} AS build
WORKDIR /src
RUN npm install -g pnpm@10.18.0 --ignore-scripts --no-audit --no-fund
COPY . .
RUN pnpm install --frozen-lockfile --ignore-scripts && pnpm build \
 && node scripts/stage.mjs && node scripts/stage-release.mjs

FROM ${NODE_IMAGE} AS runtime
ARG SOURCE_REVISION=local-unpublished
LABEL org.opencontainers.image.title="Sinty" \
      org.opencontainers.image.version="0.5.1" \
      org.opencontainers.image.revision="${SOURCE_REVISION}"
ENV NODE_ENV=production SINTY_HOME=/var/lib/sinty SINTY_INSTALL_ROOT=/opt/sinty \
    HOME=/var/lib/sinty XDG_CACHE_HOME=/var/lib/sinty/cache \
    NPM_CONFIG_CACHE=/var/lib/sinty/cache/npm
COPY --from=build /src/build/release/app/ /opt/sinty/
RUN mkdir -p /var/lib/sinty/workspace && chown -R node:node /var/lib/sinty
WORKDIR /var/lib/sinty/workspace
USER node
EXPOSE 3180
STOPSIGNAL SIGTERM
HEALTHCHECK --interval=30s --timeout=5s --start-period=45s --retries=3 \
 CMD ["node","/opt/sinty/deploy/health.mjs"]
ENTRYPOINT ["node","/opt/sinty/deploy/entrypoint.mjs"]
