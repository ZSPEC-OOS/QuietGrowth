# One image recipe for every QuietGrowth service. Build with: docker build -f infra/Dockerfile --build-arg APP=api -t quietgrowth/api .
# APP is one of: api | worker | admin | web | migrate
FROM node:22-bookworm-slim AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=true
RUN corepack enable
WORKDIR /repo

FROM base AS build
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm turbo run build

FROM base AS runtime
ARG APP
ENV NODE_ENV=production APP=${APP}
COPY --from=build /repo /repo
# Drop dev dependencies after the build; workspace packages keep their built dist/ output.
RUN pnpm prune --prod || true
RUN useradd --system --uid 10001 qg && chown -R qg /repo
USER qg
EXPOSE 3000
CMD ["sh", "-c", "case \"$APP\" in \
  api) exec node apps/api/dist/server.js ;; \
  worker) exec node apps/worker/dist/main.js ;; \
  admin) exec node apps/admin/dist/server.js ;; \
  web) exec pnpm --filter @quietgrowth/web exec next start -p ${PORT:-3000} -H 0.0.0.0 ;; \
  migrate) exec node packages/database/dist/migrate-cli.js ;; \
  *) echo \"unknown APP=$APP\" >&2; exit 64 ;; esac"]
