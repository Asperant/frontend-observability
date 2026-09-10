FROM node:24.18.0-alpine@sha256:4ba75f835bb8802193e4c114572113d4b26f95f6f094f4b5229d2a77773e0afc

RUN addgroup -g 10001 frontend-observability \
  && adduser -D -H -u 10001 -G frontend-observability frontend-observability

WORKDIR /workspace

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc .node-version ./
COPY packages/observability-contracts/package.json packages/observability-contracts/package.json
COPY packages/browser-observability/package.json packages/browser-observability/package.json
COPY packages/telemetry-delivery-core/package.json packages/telemetry-delivery-core/package.json
COPY tests/fixtures/apps/browser-app/package.json tests/fixtures/apps/browser-app/package.json
COPY tests/fixtures/apps/http-test-service/package.json tests/fixtures/apps/http-test-service/package.json
COPY apps/telemetry-ingest/package.json apps/telemetry-ingest/package.json
COPY apps/telemetry-delivery-worker/package.json apps/telemetry-delivery-worker/package.json
COPY apps/observability-control-plane/package.json apps/observability-control-plane/package.json
COPY apps/session-metadata-sync/package.json apps/session-metadata-sync/package.json

RUN npm install --global pnpm@11.15.0 \
  && pnpm install --frozen-lockfile --prod

COPY --chown=frontend-observability:frontend-observability packages/telemetry-delivery-core/src packages/telemetry-delivery-core/src
COPY --chown=frontend-observability:frontend-observability packages/observability-contracts/src packages/observability-contracts/src
COPY --chown=frontend-observability:frontend-observability packages/observability-contracts/schemas packages/observability-contracts/schemas
COPY --chown=frontend-observability:frontend-observability apps/telemetry-ingest/src apps/telemetry-ingest/src
COPY --chown=frontend-observability:frontend-observability apps/telemetry-delivery-worker/src apps/telemetry-delivery-worker/src
COPY --chown=frontend-observability:frontend-observability apps/observability-control-plane/src apps/observability-control-plane/src
COPY --chown=frontend-observability:frontend-observability apps/session-metadata-sync/src apps/session-metadata-sync/src

USER frontend-observability:frontend-observability
