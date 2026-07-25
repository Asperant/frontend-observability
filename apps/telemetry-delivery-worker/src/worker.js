import { startTelemetryDeliveryWorker } from "./runtime.js";

try {
  await startTelemetryDeliveryWorker();
} catch (error) {
  console.error(
    JSON.stringify({
      event: "telemetry_delivery_worker_start_failed",
      error: error instanceof Error ? error.message : String(error),
    }),
  );
  process.exit(1);
}
