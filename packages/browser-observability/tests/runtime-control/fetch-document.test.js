import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CONTROL_ENDPOINT_PATH } from "../../src/runtime-control/constants.js";
import {
  ControlTransportReasonCodes,
  fetchControlDocument,
} from "../../src/runtime-control/fetch-document.js";
import { ControlReasonCodes } from "../../src/runtime-control/validate-document.js";

function validDoc(overrides = {}) {
  return {
    schemaVersion: 1,
    revision: 1,
    issuedAt: "2026-07-19T19:00:00.000Z",
    expiresAt: "2026-07-19T19:05:00.000Z",
    killSwitch: { active: false, reasonCode: "none" },
    ...overrides,
  };
}

function jsonResponse(bodyText, { status = 200, contentType = "application/json" } = {}) {
  return new Response(bodyText, { status, headers: { "content-type": contentType } });
}

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("fetchControlDocument", () => {
  it("uses a GET, no-store, redirect-refused, referrer-free, same-origin exact fetch", async () => {
    globalThis.fetch = vi.fn(() => Promise.resolve(jsonResponse(JSON.stringify(validDoc()))));
    await fetchControlDocument();
    expect(globalThis.fetch).toHaveBeenCalledWith(
      CONTROL_ENDPOINT_PATH,
      expect.objectContaining({
        method: "GET",
        credentials: "omit",
        cache: "no-store",
        redirect: "error",
        referrerPolicy: "no-referrer",
        headers: { Accept: "application/json" },
        signal: expect.any(AbortSignal),
      }),
    );
  });

  it("accepts a well-formed, live document", async () => {
    globalThis.fetch = vi.fn(() => Promise.resolve(jsonResponse(JSON.stringify(validDoc()))));
    const result = await fetchControlDocument({ now: new Date("2026-07-19T19:02:00.000Z") });
    expect(result.ok).toBe(true);
    expect(result.document.revision).toBe(1);
  });

  it("rejects a non-200 or redirected response", async () => {
    globalThis.fetch = vi.fn(() => Promise.resolve(jsonResponse("{}", { status: 500 })));
    const result = await fetchControlDocument();
    expect(result).toEqual({ ok: false, reasonCode: ControlTransportReasonCodes.HTTP_ERROR });
  });

  it("rejects a non-JSON content-type", async () => {
    globalThis.fetch = vi.fn(() =>
      Promise.resolve(jsonResponse(JSON.stringify(validDoc()), { contentType: "text/plain" })),
    );
    const result = await fetchControlDocument();
    expect(result.reasonCode).toBe(ControlTransportReasonCodes.CONTENT_TYPE_INVALID);
  });

  it("rejects a body over the 8 KiB cap", async () => {
    const oversized = JSON.stringify({ ...validDoc(), padding: "x".repeat(9 * 1024) });
    globalThis.fetch = vi.fn(() => Promise.resolve(jsonResponse(oversized)));
    const result = await fetchControlDocument();
    expect(result.reasonCode).toBe(ControlTransportReasonCodes.TOO_LARGE);
  });

  it("rejects malformed JSON", async () => {
    globalThis.fetch = vi.fn(() => Promise.resolve(jsonResponse("{not json")));
    const result = await fetchControlDocument();
    expect(result.reasonCode).toBe(ControlTransportReasonCodes.JSON_INVALID);
  });

  it("rejects a duplicate top-level JSON key before ever reaching JSON.parse's last-value-wins behavior", async () => {
    const raw =
      '{"schemaVersion":1,"revision":1,"revision":2,"issuedAt":"2026-07-19T19:00:00.000Z","expiresAt":"2026-07-19T19:05:00.000Z","killSwitch":{"active":false,"reasonCode":"none"}}';
    globalThis.fetch = vi.fn(() => Promise.resolve(jsonResponse(raw)));
    const result = await fetchControlDocument();
    expect(result).toEqual({ ok: false, reasonCode: ControlReasonCodes.DUPLICATE_KEY });
  });

  it("rejects an unknown field via schema validation", async () => {
    globalThis.fetch = vi.fn(() =>
      Promise.resolve(jsonResponse(JSON.stringify({ ...validDoc(), extra: true }))),
    );
    const result = await fetchControlDocument();
    expect(result.reasonCode).toBe(ControlReasonCodes.UNKNOWN_KEY);
  });

  it("rejects an already-expired document", async () => {
    globalThis.fetch = vi.fn(() =>
      Promise.resolve(
        jsonResponse(
          JSON.stringify(
            validDoc({
              issuedAt: "2026-07-19T18:00:00.000Z",
              expiresAt: "2026-07-19T18:05:00.000Z",
            }),
          ),
        ),
      ),
    );
    const result = await fetchControlDocument({ now: new Date("2026-07-19T19:00:00.000Z") });
    expect(result.reasonCode).toBe(ControlReasonCodes.EXPIRED);
  });

  it("times out at the 3s bound", async () => {
    vi.useFakeTimers();
    globalThis.fetch = vi.fn(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init.signal.addEventListener("abort", () =>
            reject(new DOMException("aborted", "AbortError")),
          );
        }),
    );
    const promise = fetchControlDocument();
    await vi.advanceTimersByTimeAsync(3001);
    await expect(promise).resolves.toEqual({
      ok: false,
      reasonCode: ControlTransportReasonCodes.TIMEOUT,
    });
  });

  it("maps an unexpected network rejection to CONTROL_UNAVAILABLE", async () => {
    globalThis.fetch = vi.fn(() => Promise.reject(new Error("offline")));
    const result = await fetchControlDocument();
    expect(result).toEqual({ ok: false, reasonCode: ControlTransportReasonCodes.UNAVAILABLE });
  });

  it("aborts when an external signal is aborted", async () => {
    const controller = new AbortController();
    globalThis.fetch = vi.fn(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init.signal.addEventListener("abort", () =>
            reject(new DOMException("aborted", "AbortError")),
          );
        }),
    );
    const promise = fetchControlDocument({ signal: controller.signal });
    controller.abort();
    const result = await promise;
    expect(result.reasonCode).toBe(ControlTransportReasonCodes.TIMEOUT);
  });
});
