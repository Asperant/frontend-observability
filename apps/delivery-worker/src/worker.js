import {
  RABBITMQ,
  buildAmqpUrl,
  connectRabbit,
  containsUnsafeTelemetryText,
  deliverToOpenObserve,
  isKnownSignal,
  optionalIntEnv,
  readSecret,
  requiredEnv,
  retryRoutingKey,
} from "@chicek/durable-telemetry";
import { readFileSync } from "node:fs";

const PREFETCH = optionalIntEnv("WORKER_PREFETCH", 16);
const DELIVERY_TIMEOUT_MS = optionalIntEnv("OPENOBSERVE_DELIVERY_TIMEOUT_MS", 10_000);
const OPS_EMIT_INTERVAL_MS = optionalIntEnv("OPS_EMIT_INTERVAL_MS", 30_000);
const SHUTDOWN_TIMEOUT_MS = 8000;
const TEST_FAULT_SENTINEL = "stage20_5_lab_only";

let connection;
let channel;
let held = false;
let draining = false;
let consuming = false;
const consumers = new Map();
let lastSuccessfulDeliveryAt = null;
let shuttingDown = false;

const counters = {
  delivered: 0,
  retried: 0,
  deadLettered: 0,
  duplicateObserved: 0,
  lastPublisherConfirmFailure: 0,
};

const openObserve = {
  baseUrl: requiredEnv("OPENOBSERVE_INTERNAL_URL"),
  rumToken: readSecret(requiredEnv("OPENOBSERVE_RUM_TOKEN_FILE")),
  deliveryOpsToken: readSecret(requiredEnv("OPENOBSERVE_DELIVERY_OPS_TOKEN_FILE")),
  timeoutMs: DELIVERY_TIMEOUT_MS,
};

await initializeRabbit();
held = readControlHeld(process.env.DELIVERY_CONTROL_FILE);
startControlLoop();
startOpsLoop();
await resumeConsumers();
console.log(JSON.stringify({ event: "delivery_worker_started", prefetch: PREFETCH }));

async function initializeRabbit() {
  const username = readSecret(requiredEnv("RABBITMQ_WORKER_USERNAME_FILE"));
  const password = readSecret(requiredEnv("RABBITMQ_WORKER_PASSWORD_FILE"));
  connection = await connectRabbit({
    url: buildAmqpUrl({
      username,
      password,
      host: requiredEnv("RABBITMQ_HOST"),
      vhost: process.env.RABBITMQ_VHOST ?? "/",
    }),
    clientProperties: { connection_name: "chicek-delivery-worker" },
  });
  connection.on("close", () => exitOnAmqpFailure("delivery_worker_rabbitmq_closed"));
  connection.on("error", (error) =>
    exitOnAmqpFailure("delivery_worker_rabbitmq_error", error.message),
  );
  channel = await connection.createConfirmChannel();
  channel.on("close", () => exitOnAmqpFailure("delivery_worker_channel_closed"));
  channel.on("error", (error) => exitOnAmqpFailure("delivery_worker_channel_error", error.message));
  await channel.prefetch(PREFETCH);
}

function exitOnAmqpFailure(event, error) {
  if (shuttingDown) return;
  console.error(JSON.stringify({ event, ...(error ? { error } : {}) }));
  process.exit(1);
}

async function resumeConsumers() {
  if (consuming || held || shuttingDown) return;
  consuming = true;
  for (const [signal, queue] of Object.entries(RABBITMQ.queues)) {
    const consumer = await channel.consume(queue, (message) => {
      if (!message) return;
      void handleMessage(message);
    });
    consumers.set(signal, consumer.consumerTag);
  }
}

async function holdConsumers() {
  if (!consuming) return;
  for (const tag of consumers.values()) {
    await channel.cancel(tag).catch(() => {});
  }
  consumers.clear();
  consuming = false;
}

async function handleMessage(amqpMessage) {
  let message;
  try {
    message = JSON.parse(amqpMessage.content.toString("utf8"));
    validateDurableMessage(message);
    if (containsUnsafeTelemetryText(message.payload)) throw new Error("unsafe_payload_detected");
  } catch (error) {
    await publishDlq(amqpMessage, "permanent_payload_failure", error.message);
    channel.ack(amqpMessage);
    return;
  }

  const deliveryAttempt = Number(message.deliveryAttempt ?? 0) + 1;
  const deliveryMessage = { ...message, deliveryAttempt };
  if (amqpMessage.fields.redelivered) {
    console.log(
      JSON.stringify({
        event: "delivery_worker_redelivered_message_received",
        batchId: message.batchId,
        eventId: message.eventId,
        deliveryAttempt,
      }),
    );
  }
  const result = await deliverToOpenObserve(deliveryMessage, openObserve);
  if (result.accepted) {
    counters.delivered += 1;
    if (amqpMessage.fields.redelivered) counters.duplicateObserved += 1;
    lastSuccessfulDeliveryAt = new Date().toISOString();
    maybeCrashAfterOpenObserveSuccessBeforeAck(deliveryMessage, amqpMessage);
    channel.ack(amqpMessage);
    return;
  }

  if (result.retryable && deliveryAttempt < RABBITMQ.maxDeliveryAttempts) {
    await publishRetry(deliveryMessage, result.reason);
    counters.retried += 1;
    channel.ack(amqpMessage);
    return;
  }

  await publishDlq(amqpMessage, result.retryable ? "attempt_limit_exceeded" : result.reason);
  counters.deadLettered += 1;
  channel.ack(amqpMessage);
}

function validateDurableMessage(message) {
  if (!message || typeof message !== "object") throw new Error("message_not_object");
  if (!isKnownSignal(message.signal)) throw new Error("unknown_signal");
  if (typeof message.eventId !== "string" || typeof message.batchId !== "string") {
    throw new Error("missing_ids");
  }
  if (!Array.isArray(message.payload)) throw new Error("payload_not_array");
}

async function publishRetry(message, reason) {
  await publishConfirmed(retryRoutingKey(message.signal, message.deliveryAttempt), {
    ...message,
    lastDeliveryError: reason,
  });
}

async function publishDlq(amqpMessage, reason, detail = "") {
  let signal = "rum";
  let parsed;
  try {
    parsed = JSON.parse(amqpMessage.content.toString("utf8"));
    if (isKnownSignal(parsed.signal)) signal = parsed.signal;
  } catch {
    parsed = {
      schemaVersion: "20.5.0",
      eventId: amqpMessage.properties.messageId ?? "unparseable",
      batchId: amqpMessage.properties.headers?.batchId ?? "unparseable",
      signal,
      payload: [],
    };
  }
  const dlqMessage = {
    ...parsed,
    dlqReason: reason,
    dlqDetail: String(detail).slice(0, 160),
    dlqAt: new Date().toISOString(),
  };
  await publishConfirmed(RABBITMQ.dlqRoutingKeys[signal], dlqMessage);
}

function publishConfirmed(routingKey, message) {
  return new Promise((resolve, reject) => {
    channel.publish(
      RABBITMQ.exchange,
      routingKey,
      Buffer.from(JSON.stringify(message)),
      {
        contentType: "application/json",
        deliveryMode: 2,
        persistent: true,
        messageId: message.eventId,
        headers: {
          batchId: message.batchId,
          signal: message.signal,
          deliveryAttempt: message.deliveryAttempt ?? 0,
        },
        timestamp: Date.now(),
      },
      (error) => {
        if (error) reject(error);
        else resolve();
      },
    );
  });
}

function startControlLoop() {
  const controlFile = process.env.DELIVERY_CONTROL_FILE;
  if (!controlFile) return;
  setInterval(async () => {
    if (shuttingDown) return;
    const nextHeld = readControlHeld(controlFile);
    if (nextHeld === held) return;
    held = nextHeld;
    if (held) await holdConsumers();
    else await resumeConsumers();
    console.log(JSON.stringify({ event: "delivery_control_changed", held }));
  }, 2000).unref();
}

function readControlHeld(path) {
  try {
    const text = readFileSync(path, "utf8");
    const parsed = JSON.parse(text);
    return Boolean(parsed.hold);
  } catch {
    return false;
  }
}

function startOpsLoop() {
  setInterval(() => {
    if (shuttingDown) return;
    void emitOpsSummary("interval");
  }, OPS_EMIT_INTERVAL_MS).unref();
}

async function emitOpsSummary(reason) {
  try {
    const summaries = {};
    for (const [signal, queue] of Object.entries(RABBITMQ.queues)) {
      const main = await channel.checkQueue(queue);
      const dlq = await channel.checkQueue(RABBITMQ.dlqs[signal]);
      summaries[signal] = {
        queueDepth: main.messageCount,
        consumerCount: main.consumerCount,
        deadLetterDepth: dlq.messageCount,
      };
    }
    const event = {
      date: Date.now(),
      service: "delivery-worker",
      stream: "_chicek_delivery_ops",
      reason,
      held,
      draining,
      lastSuccessfulDeliveryAt,
      counters,
      queues: summaries,
    };
    await fetch(`${openObserve.baseUrl}/api/default/_chicek_delivery_ops/_json`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${Buffer.from(`default:${openObserve.deliveryOpsToken}`).toString(
          "base64",
        )}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify([event]),
    }).catch(() => {});
  } catch {
    // Operational summaries are best effort and must never block delivery.
  }
}

function maybeCrashAfterOpenObserveSuccessBeforeAck(message, amqpMessage) {
  const faultFile = process.env.WORKER_TEST_FAULT_FILE;
  if (process.env.CHICEK_ENABLE_WORKER_TEST_FAULTS !== TEST_FAULT_SENTINEL || !faultFile) return;
  let fault;
  try {
    fault = JSON.parse(readFileSync(faultFile, "utf8"));
  } catch {
    return;
  }
  if (!fault?.enabled) return;
  if (fault.mode !== "crash_after_openobserve_success_before_ack") return;
  if (fault.guard !== TEST_FAULT_SENTINEL) return;
  if (typeof fault.nonce !== "string" || fault.nonce.length < 16) return;
  if (fault.batchId && fault.batchId !== message.batchId) return;
  if (fault.eventId && fault.eventId !== message.eventId) return;
  console.error(
    JSON.stringify({
      event: "delivery_worker_test_fault_crash_after_openobserve_success_before_ack",
      batchId: message.batchId,
      eventId: message.eventId,
      deliveryAttempt: message.deliveryAttempt,
      redelivered: amqpMessage.fields.redelivered,
    }),
  );
  process.exit(42);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

async function shutdown(signal) {
  shuttingDown = true;
  console.log(JSON.stringify({ event: "delivery_worker_shutdown", signal }));
  const timer = setTimeout(() => process.exit(1), SHUTDOWN_TIMEOUT_MS);
  timer.unref();
  await holdConsumers().catch(() => {});
  await emitOpsSummary("shutdown").catch(() => {});
  await channel?.close().catch(() => {});
  await connection?.close().catch(() => {});
  process.exit(0);
}
