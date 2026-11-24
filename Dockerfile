# hucklenanny gateway — Discord transport sidecar (Bun + Hono).
# Built by droast in CI (droast + trivy) and pushed to ghcr.io/jlai403/hucklenanny-gateway.
FROM oven/bun:1 AS base
WORKDIR /app

# Pull the latest security patches for base-image packages before installing
# our own deps, so trivy's fixable CVEs (e.g. apt) don't fail the scan.
RUN apt-get update && apt-get upgrade -y --no-install-recommends && rm -rf /var/lib/apt/lists/*

# Install deps first for cache reuse.
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

COPY src ./src

# The release tag, baked by CI. /health reports it so a deploy can prove *which*
# image is serving: `ok:true` cannot tell a fresh sidecar from last week's, and
# that ambiguity is what the worker's bundle.version stamp was added to kill.
ARG GATEWAY_VERSION=dev
ENV GATEWAY_VERSION=$GATEWAY_VERSION
ARG GIT_SHA=unknown
ENV GIT_SHA=$GIT_SHA

# Drop privileges; the image ships no shell-friendly tools beyond Bun.
USER bun
ENV PORT=8090
EXPOSE 8090
HEALTHCHECK --interval=15s --timeout=5s --retries=3 CMD ["bun", "-e", "fetch('http://127.0.0.1:8090/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
CMD ["bun", "run", "src/index.ts"]
