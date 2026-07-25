export const SCHEMA_VERSION = "1.0.0";

export const SIGNALS = Object.freeze({
  rum: "rum",
  logs: "logs",
});

export const ROUTES = Object.freeze({
  "/rum/v1/default/rum": SIGNALS.rum,
  "/rum/v1/default/logs": SIGNALS.logs,
});

export const RABBITMQ = Object.freeze({
  exchange: "chicek.frontend.telemetry",
  routingKeys: Object.freeze({
    rum: "frontend.rum",
    logs: "frontend.log",
  }),
  queues: Object.freeze({
    rum: "chicek.frontend.rum.q",
    logs: "chicek.frontend.log.q",
  }),
  retryQueues: Object.freeze({
    rum: Object.freeze([
      "chicek.frontend.rum.retry.1.q",
      "chicek.frontend.rum.retry.2.q",
      "chicek.frontend.rum.retry.3.q",
    ]),
    logs: Object.freeze([
      "chicek.frontend.log.retry.1.q",
      "chicek.frontend.log.retry.2.q",
      "chicek.frontend.log.retry.3.q",
    ]),
  }),
  dlqRoutingKeys: Object.freeze({
    rum: "frontend.rum.dlq",
    logs: "frontend.log.dlq",
  }),
  dlqs: Object.freeze({
    rum: "chicek.frontend.rum.dlq",
    logs: "chicek.frontend.log.dlq",
  }),
  maxDeliveryAttempts: 16,
});

export const DEFAULT_LIMITS = Object.freeze({
  rumMaxBytes: 64 * 1024,
  logsMaxBytes: 32 * 1024,
  queueMaxBytes: 128 * 1024 * 1024,
  queueMaxLength: 25_000,
  dlqMaxBytes: 32 * 1024 * 1024,
  dlqMaxLength: 5_000,
});

export const RETRY_DELAYS_MS = Object.freeze([30_000, 120_000, 300_000]);
