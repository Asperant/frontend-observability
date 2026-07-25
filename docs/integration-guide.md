# Integration Guide

Install `@chicek/browser-observability` from the produced private tarball or a private registry.

Expose only these exact browser routes at the company ingress/WAF:

- `POST /rum/v1/default/rum`
- `POST /rum/v1/default/logs`
- `GET /observability/config.json`
- `GET /observability/control.json`

Do not expose OpenObserve search/management APIs, RabbitMQ AMQP/management, replay routes, or operator write commands to browsers.

Runtime secrets should be mounted as files or supplied by a secret manager. Do not put production domains, tokens, certificates, or private keys in the repository.

Use `scripts/operator/runtime-config.mjs`, `scripts/operator/runtime-control.mjs`, and `scripts/operator/audit.mjs` for runtime document publication and audit review.
