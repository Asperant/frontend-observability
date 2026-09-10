# Integration Guide

Install `@frontend-observability/browser-observability` from npm, or from a self-hosted registry if you build and publish the package yourself.

Expose only these exact browser routes at your ingress/WAF:

- `POST /rum/v1/default/rum`
- `POST /rum/v1/default/logs`
- `GET /observability/config.json`
- `GET /observability/control.json`

Do not expose OpenObserve search/management APIs, RabbitMQ AMQP/management, replay routes, or operator write commands to browsers.

Runtime secrets should be mounted as files or supplied by a secret manager. Do not put production domains, tokens, certificates, or private keys in the repository.

Use `scripts/operator/runtime-config.mjs`, `scripts/operator/runtime-control.mjs`, and `scripts/operator/audit.mjs` for runtime document publication and audit review.
