# Build context: repository root (a pnpm workspace build needs the root
# manifests and the workspace packages the demo depends on).
# syntax note: multi-stage — builder never ships in the final image.

FROM node:24.18.0-alpine@sha256:4ba75f835bb8802193e4c114572113d4b26f95f6f094f4b5229d2a77773e0afc AS builder

WORKDIR /workspace

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc .node-version ./
COPY packages/browser-observability/package.json packages/browser-observability/package.json
COPY packages/observability-contracts/package.json packages/observability-contracts/package.json
COPY packages/telemetry-delivery-core/package.json packages/telemetry-delivery-core/package.json
COPY tests/fixtures/apps/browser-app/package.json tests/fixtures/apps/browser-app/package.json
COPY tests/fixtures/apps/http-test-service/package.json tests/fixtures/apps/http-test-service/package.json
COPY apps/telemetry-ingest/package.json apps/telemetry-ingest/package.json
COPY apps/telemetry-delivery-worker/package.json apps/telemetry-delivery-worker/package.json

RUN npm install --global pnpm@11.15.0 \
  && pnpm install --frozen-lockfile

COPY packages/browser-observability/src packages/browser-observability/src
COPY packages/browser-observability/vite.config.js packages/browser-observability/vite.config.js
COPY packages/observability-contracts/src packages/observability-contracts/src
COPY packages/observability-contracts/schemas packages/observability-contracts/schemas
COPY tests/fixtures/apps/browser-app/src tests/fixtures/apps/browser-app/src
COPY tests/fixtures/apps/browser-app/public tests/fixtures/apps/browser-app/public
COPY tests/fixtures/apps/browser-app/index.html tests/fixtures/apps/browser-app/index.html
COPY tests/fixtures/apps/browser-app/vite.config.js tests/fixtures/apps/browser-app/vite.config.js
COPY scripts/build scripts/build

ENV VITE_MOCK_API_BASE_URL=/mock

RUN pnpm --filter @chicek/browser-observability build \
  && node scripts/build/generate-artifact-manifest.js \
  && node scripts/build/verify-build-gate.js \
  && pnpm --filter @chicek/browser-app-fixture build

# --- runtime stage: static files served by non-root Nginx, no Node/pnpm ---
FROM nginxinc/nginx-unprivileged:1.30.4-alpine@sha256:dcb6a40a82e08e071f696805a23b45d5bb6582a7508509930d3035b16b441069

COPY --chown=nginx:nginx infrastructure/docker/browser-app-fixture/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=builder --chown=nginx:nginx /workspace/tests/fixtures/apps/browser-app/dist /usr/share/nginx/html

EXPOSE 8080
