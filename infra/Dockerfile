# Single image for the whole product: Next.js serves the UI, the API under /api, and the cron-driven background loop.
#   docker build -f infra/Dockerfile -t quietgrowth .
#   docker run --env-file .env -p 3000:3000 quietgrowth                      # app
#   docker run --env-file .env quietgrowth node packages/database/dist/migrate-cli.js   # one-off migrations
FROM node:22-bookworm-slim AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=true
RUN corepack enable
WORKDIR /repo

FROM base AS build
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm turbo run build --filter=@quietgrowth/web... --filter=@quietgrowth/database

FROM base AS runtime
ENV NODE_ENV=production PORT=3000
COPY --from=build /repo /repo
RUN pnpm prune --prod || true
RUN useradd --system --uid 10001 qg && chown -R qg /repo
USER qg
EXPOSE 3000
CMD ["pnpm", "--filter", "@quietgrowth/web", "exec", "next", "start", "-p", "3000", "-H", "0.0.0.0"]
