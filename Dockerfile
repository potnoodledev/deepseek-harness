FROM node:22.19-bookworm-slim

WORKDIR /app

COPY . .

RUN apt-get update \
  && apt-get install --yes --no-install-recommends python3 make g++ git \
  && rm -rf /var/lib/apt/lists/* \
  && npm install --global pnpm@11.7.0 \
  && pnpm install --frozen-lockfile \
  && pnpm run build \
  && pnpm store prune

CMD ["pnpm", "dsh", "web", "--patch", "deploy/railway/web.cordis.yml"]
