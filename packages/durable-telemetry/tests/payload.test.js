// @vitest-environment node
import { describe, expect, it } from "vitest";

import { RABBITMQ } from "../src/constants.js";
import { buildDurableMessage, encodeOpenObserveBody } from "../src/payload.js";
import { containsUnsafeTelemetryText } from "../src/redaction.js";
import { retryRoutingKey } from "../src/rabbitmq.js";

function rumEvent(extra = {}) {
  return {
    date: Date.now(),
    type: "view",
    service: "demo-frontend",
    env: "lab",
    version: "2026.07.1",
    session: { id: "session-id" },
    view: {
      id: "view-id",
      url: "https://localhost:8443/orders/123?token=secret#frag",
    },
    ...extra,
  };
}

describe("buildDurableMessage", () => {
  it("creates a sanitized durable envelope without persisting raw query strings", () => {
    const message = buildDurableMessage({
      signal: "rum",
      rawBody: Buffer.from(JSON.stringify(rumEvent())),
      receivedAt: new Date("2026-07-23T00:00:00.000Z"),
    });

    expect(message).toMatchObject({
      schemaVersion: "20.5.0",
      signal: "rum",
      deliveryAttempt: 0,
      receivedAt: "2026-07-23T00:00:00.000Z",
    });
    expect(message.eventId).toMatch(/^[0-9a-f-]{36}$/);
    expect(message.batchId).toMatch(/^[0-9a-f-]{36}$/);
    expect(JSON.stringify(message)).not.toContain("token=secret");
    expect(JSON.stringify(message)).not.toContain("#frag");
    expect(message.payload[0].view.url).toBe("https://localhost:8443/orders/123");
  });

  it("strips query strings from root-relative URLs before persistence", () => {
    const message = buildDurableMessage({
      signal: "rum",
      rawBody: Buffer.from(
        JSON.stringify(rumEvent({ view: { id: "view-id", url: "/?token=secret#frag" } })),
      ),
    });

    expect(message.payload[0].view.url).toBe("/");
    expect(JSON.stringify(message)).not.toContain("token=secret");
    expect(JSON.stringify(message)).not.toContain("#frag");
  });

  it("rejects replay, DOM, body, cookie and authorization bypass payloads before persistence", () => {
    const unsafePayloads = [
      { replay: { segment: "x" } },
      { dom: "<input value='secret'>" },
      { request: { body: "secret" } },
      { cookie: "sid=secret" },
      { authorization: "Bearer abcdefghijklmnopqrstuvwxyz" },
      { view: { url: "https://localhost:8443", ip: "192.168.1.10" } },
    ];

    for (const extra of unsafePayloads) {
      expect(() =>
        buildDurableMessage({
          signal: "rum",
          rawBody: Buffer.from(JSON.stringify(rumEvent(extra))),
        }),
      ).toThrow();
    }
  });

  it("fails closed on unknown nested structures and secret-like values", () => {
    const withPrivateKey = rumEvent({
      error: { message: "-----BEGIN PRIVATE KEY----- abc -----END PRIVATE KEY-----" },
    });
    expect(() =>
      buildDurableMessage({ signal: "rum", rawBody: Buffer.from(JSON.stringify(withPrivateKey)) }),
    ).toThrow();
  });

  it("encodes one accepted browser batch as one persisted message body for OpenObserve delivery", () => {
    const message = buildDurableMessage({
      signal: "logs",
      rawBody: Buffer.from(
        JSON.stringify([
          {
            date: Date.now(),
            message: "safe log",
            status: "info",
            service: "demo-frontend",
          },
        ]),
      ),
    });

    expect(message.payload).toHaveLength(1);
    expect(encodeOpenObserveBody(message)).toContain("safe log");
    expect(containsUnsafeTelemetryText(message.payload)).toBe(false);
  });

  it("accepts canonical SDK measurement keys without persisting user action helpers", () => {
    const message = buildDurableMessage({
      signal: "rum",
      rawBody: Buffer.from(
        JSON.stringify({
          date: Date.now(),
          type: "resource",
          service: "demo-frontend",
          session: { id: "session-id" },
          resource: {
            id: "resource-id",
            type: "js",
            url: "/assets/app.js?token=secret",
            document_version: 1,
            dom_complete: 10,
            dom_content_loaded: 8,
            dom_interactive: 6,
            encoded_body_size: 12,
            decoded_body_size: 34,
            first_input_delay: 1,
            first_input_time: 2,
            first_input_target_selector: "BUTTON[data-testid='safe']",
          },
          replay_level: 0,
          sampled_for_replay: false,
          start_session_replay_recording_manually: false,
          user_action: { id: ["action-id"] },
        }),
      ),
    });

    expect(message.payload[0].resource.encoded_body_size).toBe(12);
    expect(message.payload[0].resource.decoded_body_size).toBe(34);
    expect(message.payload[0].resource.document_version).toBe(1);
    expect(message.payload[0].resource.dom_complete).toBe(10);
    expect(message.payload[0].resource.dom_content_loaded).toBe(8);
    expect(message.payload[0].resource.dom_interactive).toBe(6);
    expect(message.payload[0].resource.first_input_delay).toBe(1);
    expect(message.payload[0].resource.first_input_time).toBe(2);
    expect(message.payload[0].resource.first_input_target_selector).toBe(
      "BUTTON[data-testid='safe']",
    );
    expect(message.payload[0].resource.url).toBe("/assets/app.js");
    expect(message.payload[0].session.id).toBe("session-id");
    expect(message.payload[0]).not.toHaveProperty("replay_level");
    expect(message.payload[0]).not.toHaveProperty("sampled_for_replay");
    expect(message.payload[0]).not.toHaveProperty("start_session_replay_recording_manually");
    expect(message.payload[0]).not.toHaveProperty("user_action");
  });
});

describe("RabbitMQ retry routing", () => {
  it("uses bounded delayed retry queues before finite DLQ attempts", () => {
    expect(RABBITMQ.maxDeliveryAttempts).toBe(16);
    expect(retryRoutingKey("rum", 1)).toBe("frontend.rum.retry.1");
    expect(retryRoutingKey("rum", 2)).toBe("frontend.rum.retry.2");
    expect(retryRoutingKey("rum", 3)).toBe("frontend.rum.retry.3");
    expect(retryRoutingKey("rum", 999)).toBe("frontend.rum.retry.3");
  });
});
