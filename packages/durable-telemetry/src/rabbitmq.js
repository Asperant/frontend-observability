import amqp from "amqplib";

import { RABBITMQ, RETRY_DELAYS_MS, DEFAULT_LIMITS } from "./constants.js";

const RETRY_ROUTING = Object.freeze({
  rum: Object.freeze(["frontend.rum.retry.1", "frontend.rum.retry.2", "frontend.rum.retry.3"]),
  logs: Object.freeze(["frontend.log.retry.1", "frontend.log.retry.2", "frontend.log.retry.3"]),
});

export function buildAmqpUrl({ username, password, host, port = 5672, vhost = "/" }) {
  return `amqp://${encodeURIComponent(username)}:${encodeURIComponent(password)}@${host}:${port}/${encodeURIComponent(vhost).replace("%2F", "")}`;
}

export async function connectRabbit({ url, clientProperties }) {
  return amqp.connect(url, { clientProperties });
}

export async function assertTopology(channel, limits = DEFAULT_LIMITS) {
  await channel.assertExchange(RABBITMQ.exchange, "direct", {
    durable: true,
    autoDelete: false,
  });

  for (const signal of ["rum", "logs"]) {
    await channel.assertQueue(RABBITMQ.dlqs[signal], {
      durable: true,
      arguments: queueLimitArgs(limits, "dlq"),
    });
    await channel.bindQueue(
      RABBITMQ.dlqs[signal],
      RABBITMQ.exchange,
      RABBITMQ.dlqRoutingKeys[signal],
    );

    await channel.assertQueue(RABBITMQ.queues[signal], {
      durable: true,
      arguments: {
        "x-queue-type": "quorum",
        "x-delivery-limit": RABBITMQ.maxDeliveryAttempts,
        "x-dead-letter-exchange": RABBITMQ.exchange,
        "x-dead-letter-routing-key": RABBITMQ.dlqRoutingKeys[signal],
        ...queueLimitArgs(limits, "main"),
      },
    });
    await channel.bindQueue(
      RABBITMQ.queues[signal],
      RABBITMQ.exchange,
      RABBITMQ.routingKeys[signal],
    );

    for (const [index, retryQueue] of RABBITMQ.retryQueues[signal].entries()) {
      await channel.assertQueue(retryQueue, {
        durable: true,
        arguments: {
          "x-queue-type": "quorum",
          "x-message-ttl": RETRY_DELAYS_MS[index],
          "x-dead-letter-exchange": RABBITMQ.exchange,
          "x-dead-letter-routing-key": RABBITMQ.routingKeys[signal],
          ...queueLimitArgs(limits, "main"),
        },
      });
      await channel.bindQueue(retryQueue, RABBITMQ.exchange, RETRY_ROUTING[signal][index]);
    }
  }
}

export function retryRoutingKey(signal, deliveryAttempt) {
  const index = Math.max(0, Math.min(RETRY_DELAYS_MS.length - 1, deliveryAttempt - 1));
  return RETRY_ROUTING[signal][index];
}

export function isKnownSignal(signal) {
  return signal === "rum" || signal === "logs";
}

function queueLimitArgs(limits, kind) {
  return {
    "x-overflow": "reject-publish",
    "x-max-length": kind === "dlq" ? limits.dlqMaxLength : limits.queueMaxLength,
    "x-max-length-bytes": kind === "dlq" ? limits.dlqMaxBytes : limits.queueMaxBytes,
  };
}
