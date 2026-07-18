# Build context: repository root (a pnpm workspace build needs the root
# manifests and the workspace packages the demo depends on).
# syntax note: multi-stage — builder never ships in the final image.

FROM node:24.18.0-alpine@sha256:4ba75f835bb8802193e4c114572113d4b26f95f6f094f4b5229d2a77773e0afc AS builder

WORKDIR /workspace

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc .node-version ./
COPY packages/browser-observability/package.json packages/browser-observability/package.json
COPY packages/contracts/package.json packages/contracts/package.json
COPY apps/demo-frontend/package.json apps/demo-frontend/package.json
COPY apps/mock-api/package.json apps/mock-api/package.json

RUN npm install --global pnpm@11.15.0 \
  && pnpm install --frozen-lockfile

COPY packages/browser-observability/src packages/browser-observability/src
COPY packages/browser-observability/vite.config.js packages/browser-observability/vite.config.js
COPY packages/contracts/src packages/contracts/src
COPY packages/contracts/schemas packages/contracts/schemas
COPY apps/demo-frontend/src apps/demo-frontend/src
COPY apps/demo-frontend/index.html apps/demo-frontend/index.html
COPY apps/demo-frontend/vite.config.js apps/demo-frontend/vite.config.js
COPY scripts/build scripts/build

ENV VITE_MOCK_API_BASE_URL=/mock

RUN pnpm --filter @chicek/browser-observability build \
  && node scripts/build/generate-artifact-manifest.js \
  && node scripts/build/verify-build-gate.js \
  && pnpm --filter @chicek/demo-frontend build

# --- runtime stage: static files served by non-root Nginx, no Node/pnpm ---
FROM nginxinc/nginx-unprivileged:1.30.4-alpine@sha256:dcb6a40a82e08e071f696805a23b45d5bb6582a7508509930d3035b16b441069

COPY --chown=nginx:nginx infrastructure/docker/demo-frontend/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=builder --chown=nginx:nginx /workspace/apps/demo-frontend/dist /usr/share/nginx/html

EXPOSE 8080
