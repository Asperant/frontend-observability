// @vitest-environment node
import { createServer } from "node:http";
import { afterEach, describe, expect, it } from "vitest";

import {
  createRuntimeControlGuard,
  validateControlUrl,
  validateControlDocument,
} from "../src/runtime-control.js";

const SCOPE = { service: "browser-app", environment: "lab" };

function futureDocument(overrides = {}) {
  const now = Date.now();
  return {
    schemaVersion: 1,
    revision: 1,
    issuedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + 60_000).toISOString(),
    killSwitch: { active: false, reasonCode: "none" },
    ...overrides,
  };
}

async function startControlServer(handler) {
  const server = createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return { server, url: `http://127.0.0.1:${port}/observability/control.json` };
}

function sendJson(res, statusCode, body) {
  const payload = JSON.stringify(body);
  res.writeHead(statusCode, { "content-type": "application/json" });
  res.end(payload);
}

describe("validateControlUrl", () => {
  it("returns the value unchanged when it is a well-formed URL", () => {
    expect(validateControlUrl("http://127.0.0.1:4314/observability/control.json")).toBe(
      "http://127.0.0.1:4314/observability/control.json",
    );
  });

  it("throws a bounded error for an invalid URL, without echoing the raw value", () => {
    expect(() => validateControlUrl("not-a-url")).toThrow(
      "invalid_environment_variable: OBSERVABILITY_CONTROL_URL",
    );
  });

  it("throws a bounded error for an empty string", () => {
    expect(() => validateControlUrl("")).toThrow(
      "invalid_environment_variable: OBSERVABILITY_CONTROL_URL",
    );
  });
});

describe("validateControlDocument", () => {
  it("accepts a well-formed, unexpired, disabled-kill-switch document", () => {
    expect(validateControlDocument(futureDocument())).toEqual({ valid: true });
  });

  it("rejects a non-object document", () => {
    expect(validateControlDocument(null).valid).toBe(false);
    expect(validateControlDocument("hello").valid).toBe(false);
    expect(validateControlDocument([1, 2, 3]).valid).toBe(false);
  });

  it("rejects an unsupported schemaVersion", () => {
    const result = validateControlDocument(futureDocument({ schemaVersion: 2 }));
    expect(result).toEqual({ valid: false, reason: "runtime_control_invalid" });
  });

  it("rejects a negative or non-integer revision", () => {
    expect(validateControlDocument(futureDocument({ revision: -1 })).valid).toBe(false);
    expect(validateControlDocument(futureDocument({ revision: 1.5 })).valid).toBe(false);
  });

  it("rejects an expired document with a distinct reason code", () => {
    const now = Date.now();
    const result = validateControlDocument(
      futureDocument({
        issuedAt: new Date(now - 120_000).toISOString(),
        expiresAt: new Date(now - 60_000).toISOString(),
      }),
    );
    expect(result).toEqual({ valid: false, reason: "runtime_control_expired" });
  });

  it("rejects expiresAt <= issuedAt", () => {
    const now = Date.now();
    const result = validateControlDocument(
      futureDocument({
        issuedAt: new Date(now).toISOString(),
        expiresAt: new Date(now).toISOString(),
      }),
    );
    expect(result).toEqual({ valid: false, reason: "runtime_control_invalid" });
  });

  it("rejects a non-boolean killSwitch.active", () => {
    const result = validateControlDocument(
      futureDocument({ killSwitch: { active: "yes", reasonCode: "none" } }),
    );
    expect(result).toEqual({ valid: false, reason: "runtime_control_invalid" });
  });

  it("rejects a reasonCode outside the allowlist", () => {
    const result = validateControlDocument(
      futureDocument({ killSwitch: { active: false, reasonCode: "made_up_reason" } }),
    );
    expect(result).toEqual({ valid: false, reason: "runtime_control_invalid" });
  });
});

describe("createRuntimeControlGuard", () => {
  let server;

  afterEach(async () => {
    if (server) await new Promise((resolve) => server.close(resolve));
    server = undefined;
  });

  it("throws runtime_control_unavailable on connection failure", async () => {
    const guard = createRuntimeControlGuard({
      url: "http://127.0.0.1:1/observability/control.json",
      timeoutMs: 500,
    });
    await expect(guard(SCOPE)).rejects.toMatchObject({
      statusCode: 503,
      code: "runtime_control_unavailable",
    });
  });

  it("throws runtime_control_unavailable on timeout", async () => {
    const started = await startControlServer(() => {
      // Never respond — forces the client-side abort timeout.
    });
    server = started.server;
    const guard = createRuntimeControlGuard({ url: started.url, timeoutMs: 50 });
    await expect(guard(SCOPE)).rejects.toMatchObject({
      statusCode: 503,
      code: "runtime_control_unavailable",
    });
  });

  it("throws runtime_control_unavailable on non-200", async () => {
    const started = await startControlServer((req, res) => sendJson(res, 500, { error: "boom" }));
    server = started.server;
    const guard = createRuntimeControlGuard({ url: started.url, timeoutMs: 1000 });
    await expect(guard(SCOPE)).rejects.toMatchObject({
      statusCode: 503,
      code: "runtime_control_unavailable",
    });
  });

  it("throws runtime_control_invalid on malformed JSON", async () => {
    const started = await startControlServer((req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{not json");
    });
    server = started.server;
    const guard = createRuntimeControlGuard({ url: started.url, timeoutMs: 1000 });
    await expect(guard(SCOPE)).rejects.toMatchObject({
      statusCode: 503,
      code: "runtime_control_invalid",
    });
  });

  it("throws runtime_control_invalid on an unsupported schema version", async () => {
    const started = await startControlServer((req, res) =>
      sendJson(res, 200, futureDocument({ schemaVersion: 99 })),
    );
    server = started.server;
    const guard = createRuntimeControlGuard({ url: started.url, timeoutMs: 1000 });
    await expect(guard(SCOPE)).rejects.toMatchObject({
      statusCode: 503,
      code: "runtime_control_invalid",
    });
  });

  it("throws runtime_control_invalid on an invalid revision", async () => {
    const started = await startControlServer((req, res) =>
      sendJson(res, 200, futureDocument({ revision: -5 })),
    );
    server = started.server;
    const guard = createRuntimeControlGuard({ url: started.url, timeoutMs: 1000 });
    await expect(guard(SCOPE)).rejects.toMatchObject({
      statusCode: 503,
      code: "runtime_control_invalid",
    });
  });

  it("throws runtime_control_expired on an expired document", async () => {
    const now = Date.now();
    const started = await startControlServer((req, res) =>
      sendJson(
        res,
        200,
        futureDocument({
          issuedAt: new Date(now - 120_000).toISOString(),
          expiresAt: new Date(now - 60_000).toISOString(),
        }),
      ),
    );
    server = started.server;
    const guard = createRuntimeControlGuard({ url: started.url, timeoutMs: 1000 });
    await expect(guard(SCOPE)).rejects.toMatchObject({
      statusCode: 503,
      code: "runtime_control_expired",
    });
  });

  it("throws runtime_control_disabled when the kill switch is active", async () => {
    const started = await startControlServer((req, res) =>
      sendJson(
        res,
        200,
        futureDocument({ killSwitch: { active: true, reasonCode: "security_incident" } }),
      ),
    );
    server = started.server;
    const guard = createRuntimeControlGuard({ url: started.url, timeoutMs: 1000 });
    await expect(guard(SCOPE)).rejects.toMatchObject({
      statusCode: 503,
      code: "runtime_control_disabled",
    });
  });

  it("resolves without throwing for a valid, enabled control document", async () => {
    const started = await startControlServer((req, res) => sendJson(res, 200, futureDocument()));
    server = started.server;
    const guard = createRuntimeControlGuard({ url: started.url, timeoutMs: 1000 });
    await expect(guard(SCOPE)).resolves.toBeUndefined();
  });

  it("rejects admission during an outage and resumes after control recovers", async () => {
    let healthy = false;
    const started = await startControlServer((req, res) => {
      if (!healthy) {
        res.destroy();
        return;
      }
      sendJson(res, 200, futureDocument());
    });
    server = started.server;
    const guard = createRuntimeControlGuard({ url: started.url, timeoutMs: 1000 });

    await expect(guard(SCOPE)).rejects.toMatchObject({
      statusCode: 503,
      code: "runtime_control_unavailable",
    });

    healthy = true;
    await expect(guard(SCOPE)).resolves.toBeUndefined();
  });
});
