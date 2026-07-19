// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { MAX_DELAY_MS, createMockApiServer } from "../src/create-server.js";

let server;
let baseUrl;

beforeAll(async () => {
  server = createMockApiServer();
  await new Promise((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address();
  baseUrl = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

describe("GET /health", () => {
  it("returns 200 ok", async () => {
    const response = await fetch(`${baseUrl}/health`);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ status: "ok" });
  });
});

describe("GET /status/:code", () => {
  it.each([200, 400, 404, 429, 500, 503])("returns status %i deterministically", async (code) => {
    const response = await fetch(`${baseUrl}/status/${code}`);
    expect(response.status).toBe(code);
    await expect(response.json()).resolves.toEqual({ status: code });
  });

  it("returns 404 for an unsupported status code", async () => {
    const response = await fetch(`${baseUrl}/status/999`);
    expect(response.status).toBe(404);
  });
});

describe("GET /delay/:milliseconds", () => {
  it("waits approximately the requested delay", async () => {
    const start = Date.now();
    const response = await fetch(`${baseUrl}/delay/50`);
    const elapsed = Date.now() - start;
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ delayedMs: 50 });
    expect(elapsed).toBeGreaterThanOrEqual(40);
  });

  it(
    "caps the delay at MAX_DELAY_MS even for larger requests",
    async () => {
      const response = await fetch(`${baseUrl}/delay/999999`);
      await expect(response.json()).resolves.toEqual({ delayedMs: MAX_DELAY_MS });
    },
    MAX_DELAY_MS + 5000,
  );

  it("treats a non-numeric delay as zero", async () => {
    const response = await fetch(`${baseUrl}/delay/not-a-number`);
    await expect(response.json()).resolves.toEqual({ delayedMs: 0 });
  });
});

describe("GET /large-response", () => {
  it("returns a large, deterministic payload", async () => {
    const response = await fetch(`${baseUrl}/large-response`);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.items).toHaveLength(5000);
    expect(body.items[0]).toEqual({ index: 0, value: "x".repeat(32) });
  });
});

describe("GET /headers", () => {
  it("reports forbidden correlation/tracing header presence without returning values", async () => {
    const response = await fetch(`${baseUrl}/headers`, {
      headers: { traceparent: "00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01" },
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      forbiddenCorrelationHeaders: {
        traceparent: true,
        tracestate: false,
        baggage: false,
        "x-request-id": false,
        "x-correlation-id": false,
        "x-datadog-trace-id": false,
        "x-datadog-parent-id": false,
      },
    });
  });
});

describe("GET /timeout", () => {
  it("never responds within a short client-side window", async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 200);
    await expect(fetch(`${baseUrl}/timeout`, { signal: controller.signal })).rejects.toThrow();
    clearTimeout(timer);
  });
});

describe("unsupported requests", () => {
  it("returns 404 for an unknown route", async () => {
    const response = await fetch(`${baseUrl}/does-not-exist`);
    expect(response.status).toBe(404);
  });

  it("returns 405 for a non-GET method", async () => {
    const response = await fetch(`${baseUrl}/health`, { method: "POST" });
    expect(response.status).toBe(405);
  });
});
