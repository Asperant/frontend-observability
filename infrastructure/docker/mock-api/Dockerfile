# Build context: apps/mock-api (no workspace dependencies — Node built-in
# HTTP only, so no install step and no node_modules at all).
FROM node:24.18.0-alpine@sha256:4ba75f835bb8802193e4c114572113d4b26f95f6f094f4b5229d2a77773e0afc

RUN addgroup -g 10001 mockapi \
  && adduser -D -H -u 10001 -G mockapi mockapi

WORKDIR /app
COPY --chown=mockapi:mockapi package.json ./package.json
COPY --chown=mockapi:mockapi src ./src

USER mockapi:mockapi
ENV PORT=4311
EXPOSE 4311

ENTRYPOINT ["node", "src/server.js"]
