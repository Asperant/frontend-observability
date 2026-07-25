import { startTelemetryDeliveryWorker } from "/workspace/apps/telemetry-delivery-worker/src/runtime.js";

const expectedEventId = requiredEnv("TEST_PREACK_EVENT_ID");
const expectedBatchId = requiredEnv("TEST_PREACK_BATCH_ID");

await startTelemetryDeliveryWorker({
  async afterAcceptedBeforeAck({ message }) {
    if (message.eventId !== expectedEventId || message.batchId !== expectedBatchId) return;
    console.log(
      JSON.stringify({
        event: "pre_ack_redelivery_harness_exit_after_openobserve_success_before_ack",
        eventId: message.eventId,
        batchId: message.batchId,
        deliveryAttempt: message.deliveryAttempt,
      }),
    );
    process.exit(99);
  },
});

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}
