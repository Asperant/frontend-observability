import { describe, expect, it } from "vitest";

import {
  NOTIFICATION_READINESS_STATUS,
  buildProbeId,
  classifyNotificationReadiness,
  parseProbeEvents,
} from "../../../../scripts/performance/lib/notification-readiness.js";

describe("buildProbeId", () => {
  it("embeds a random uuid by default", () => {
    const id = buildProbeId();
    expect(id).toMatch(/^stage19-notification-probe-[0-9a-f-]{36}$/);
  });

  it("accepts an injected uuid for deterministic tests", () => {
    expect(buildProbeId("fixed-uuid")).toBe("stage19-notification-probe-fixed-uuid");
  });

  it("produces distinct ids across calls when not injected", () => {
    expect(buildProbeId()).not.toBe(buildProbeId());
  });
});

describe("parseProbeEvents", () => {
  const probeId = "stage19-notification-probe-abc";

  it("finds matching firing and resolved events by dedupKey", () => {
    const events = [
      { receivedAt: "t1", body: { dedupKey: "other", status: "firing" } },
      { receivedAt: "t2", body: { dedupKey: probeId, status: "firing" } },
      { receivedAt: "t3", body: { dedupKey: probeId, status: "resolved" } },
    ];
    expect(parseProbeEvents(events, probeId)).toEqual({
      firingObserved: true,
      firingReceivedAt: "t2",
      resolvedObserved: true,
      resolvedReceivedAt: "t3",
    });
  });

  it("reports both as unobserved when nothing matches", () => {
    expect(parseProbeEvents([{ body: { dedupKey: "other", status: "firing" } }], probeId)).toEqual({
      firingObserved: false,
      firingReceivedAt: null,
      resolvedObserved: false,
      resolvedReceivedAt: null,
    });
  });

  it("handles a non-array or malformed events input", () => {
    expect(parseProbeEvents(null, probeId).firingObserved).toBe(false);
    expect(parseProbeEvents([{}], probeId).firingObserved).toBe(false);
  });
});

const HEALTHY_INPUT = {
  destinationConfigured: true,
  firingObserved: true,
  resolvedObserved: true,
  firingLatencyMs: 500,
  resolvedLatencyMs: 600,
  targetLatencyMs: 5000,
  hardTimeoutMs: 10000,
};

describe("classifyNotificationReadiness", () => {
  it("classifies NOT_CONFIGURED when no destination exists", () => {
    const result = classifyNotificationReadiness({
      ...HEALTHY_INPUT,
      destinationConfigured: false,
    });
    expect(result.status).toBe(NOTIFICATION_READINESS_STATUS.NOT_CONFIGURED);
  });

  it("classifies FAILED when neither notification arrives (silent loss)", () => {
    const result = classifyNotificationReadiness({
      ...HEALTHY_INPUT,
      firingObserved: false,
      resolvedObserved: false,
    });
    expect(result.status).toBe(NOTIFICATION_READINESS_STATUS.FAILED);
    expect(result.reason).toMatch(/neither/);
  });

  it("classifies FAILED when only firing arrives", () => {
    const result = classifyNotificationReadiness({ ...HEALTHY_INPUT, resolvedObserved: false });
    expect(result.status).toBe(NOTIFICATION_READINESS_STATUS.FAILED);
    expect(result.reason).toMatch(/resolved probe notification never reached/);
  });

  it("classifies FAILED when only resolved arrives", () => {
    const result = classifyNotificationReadiness({ ...HEALTHY_INPUT, firingObserved: false });
    expect(result.status).toBe(NOTIFICATION_READINESS_STATUS.FAILED);
    expect(result.reason).toMatch(/firing probe notification never reached/);
  });

  it("classifies FAILED when a notification exceeds the hard timeout", () => {
    const result = classifyNotificationReadiness({ ...HEALTHY_INPUT, firingLatencyMs: 20000 });
    expect(result.status).toBe(NOTIFICATION_READINESS_STATUS.FAILED);
    expect(result.reason).toMatch(/hard timeout/);
  });

  it("classifies DEGRADED when a notification exceeds target latency but not the hard timeout", () => {
    const result = classifyNotificationReadiness({ ...HEALTHY_INPUT, resolvedLatencyMs: 7000 });
    expect(result.status).toBe(NOTIFICATION_READINESS_STATUS.DEGRADED);
  });

  it("classifies HEALTHY when both notifications arrive within target latency", () => {
    const result = classifyNotificationReadiness(HEALTHY_INPUT);
    expect(result.status).toBe(NOTIFICATION_READINESS_STATUS.HEALTHY);
  });

  it("tolerates missing latency values (treated as not exceeding any bound)", () => {
    const result = classifyNotificationReadiness({
      ...HEALTHY_INPUT,
      firingLatencyMs: null,
      resolvedLatencyMs: undefined,
    });
    expect(result.status).toBe(NOTIFICATION_READINESS_STATUS.HEALTHY);
  });
});
