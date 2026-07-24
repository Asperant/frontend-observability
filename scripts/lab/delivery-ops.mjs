import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import {
  assertExactLabToolchain,
  atomicWriteFile,
  deliveryControlPath,
  log,
  logError,
  runDockerCompose,
} from "./common.mjs";

export function writeDeliveryControl({ hold, reason }) {
  const document = {
    schemaVersion: 1,
    hold: Boolean(hold),
    reason: String(reason || "operator_request").slice(0, 64),
    updatedAt: new Date().toISOString(),
  };
  atomicWriteFile(deliveryControlPath, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o644 });
  return document;
}

export function readDeliveryControl() {
  try {
    return JSON.parse(readFileSync(deliveryControlPath, "utf8"));
  } catch {
    return null;
  }
}

export function holdDelivery() {
  return writeDeliveryControl({ hold: true, reason: "operator_hold" });
}

export function resumeDelivery() {
  return writeDeliveryControl({ hold: false, reason: "operator_resume" });
}

export function purgeQueues({ confirm }) {
  if (confirm !== "PURGE-DURABLE-FRONTEND-TELEMETRY") {
    throw new Error("purge requires --confirm PURGE-DURABLE-FRONTEND-TELEMETRY");
  }
  const queues = [
    "chicek.frontend.rum.q",
    "chicek.frontend.log.q",
    "chicek.frontend.rum.retry.1.q",
    "chicek.frontend.rum.retry.2.q",
    "chicek.frontend.rum.retry.3.q",
    "chicek.frontend.log.retry.1.q",
    "chicek.frontend.log.retry.2.q",
    "chicek.frontend.log.retry.3.q",
    "chicek.frontend.rum.dlq",
    "chicek.frontend.log.dlq",
  ];
  const results = [];
  for (const queue of queues) {
    const result = runDockerCompose(
      ["exec", "-T", "rabbitmq", "rabbitmqctl", "purge_queue", queue],
      { capture: true, allowFailure: true },
    );
    results.push({
      queue,
      exitCode: result.status,
      outputHash: createHash("sha256")
        .update(`${result.stdout ?? ""}${result.stderr ?? ""}`)
        .digest("hex"),
    });
  }
  return {
    schemaVersion: 1,
    action: "purge",
    confirmed: true,
    purgedAt: new Date().toISOString(),
    queues: results,
  };
}

export function drainDelivery() {
  resumeDelivery();
  return {
    schemaVersion: 1,
    action: "drain",
    startedAt: new Date().toISOString(),
    note: "delivery-worker resumes consumers; queue depth is inspected via RabbitMQ Management UI or Stage 20.5 gates",
  };
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const confirmIndex = rest.indexOf("--confirm");
  return {
    command,
    confirm: confirmIndex >= 0 ? rest[confirmIndex + 1] : undefined,
  };
}

const isMainModule = process.argv[1] === new URL(import.meta.url).pathname;
if (isMainModule) {
  try {
    assertExactLabToolchain("lab:delivery");
    const { command, confirm } = parseArgs(process.argv.slice(2));
    let result;
    if (command === "hold") result = holdDelivery();
    else if (command === "resume") result = resumeDelivery();
    else if (command === "drain") result = drainDelivery();
    else if (command === "purge") result = purgeQueues({ confirm });
    else if (command === "status") result = readDeliveryControl();
    else
      throw new Error(
        `unknown command "${command ?? ""}"; expected hold, resume, drain, purge, status`,
      );
    log(JSON.stringify(result, null, 2));
  } catch (error) {
    logError(`lab:delivery FAILED: ${error.message}`);
    process.exit(1);
  }
}
