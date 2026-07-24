FROM node:24.18.0-alpine@sha256:4ba75f835bb8802193e4c114572113d4b26f95f6f094f4b5229d2a77773e0afc

RUN addgroup -g 10001 chicek \
  && adduser -D -H -u 10001 -G chicek chicek

WORKDIR /workspace

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc .node-version ./
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/browser-observability/package.json packages/browser-observability/package.json
COPY packages/durable-telemetry/package.json packages/durable-telemetry/package.json
COPY apps/demo-frontend/package.json apps/demo-frontend/package.json
COPY apps/mock-api/package.json apps/mock-api/package.json
COPY apps/durable-ingest/package.json apps/durable-ingest/package.json
COPY apps/delivery-worker/package.json apps/delivery-worker/package.json

RUN npm install --global pnpm@11.15.0 \
  && pnpm install --frozen-lockfile --prod

COPY --chown=chicek:chicek packages/durable-telemetry/src packages/durable-telemetry/src
COPY --chown=chicek:chicek apps/durable-ingest/src apps/durable-ingest/src
COPY --chown=chicek:chicek apps/delivery-worker/src apps/delivery-worker/src

USER chicek:chicek
