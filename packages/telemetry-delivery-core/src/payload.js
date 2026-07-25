import { randomUUID } from "node:crypto";

import { ROUTES, SCHEMA_VERSION } from "./constants.js";
import { SanitizationError, sanitizeBrowserBatch } from "./redaction.js";

export class AdmissionError extends Error {
  constructor(statusCode, code) {
    super(code);
    this.name = "AdmissionError";
    this.statusCode = statusCode;
    this.code = code;
  }
}

export function validateAdmissionRequest({ method, url, headers, rawBody, maxBytes }) {
  const parsedUrl = new URL(url, "http://telemetry-ingest.internal");
  const signal = ROUTES[parsedUrl.pathname];
  if (!signal || parsedUrl.search) throw new AdmissionError(404, "route_not_allowed");
  if (method !== "POST") throw new AdmissionError(405, "method_not_allowed");
  if (rawBody.length > maxBytes) throw new AdmissionError(413, "payload_too_large");

  const contentType = String(headers["content-type"] ?? "");
  if (!/^text\/plain(?:\s*;\s*charset\s*=\s*utf-8)?$/i.test(contentType)) {
    throw new AdmissionError(415, "unsupported_content_type");
  }

  return { signal, path: parsedUrl.pathname };
}

export function buildDurableMessage({ signal, rawBody, receivedAt = new Date(), trustedScope }) {
  const decoded = safeDecode(rawBody);
  const sanitizedPayload = sanitizeBrowserBatch(decoded, { signal }).map((event) =>
    canonicalizeScope(event, trustedScope),
  );
  const eventId = randomUUID();
  const batchId = randomUUID();
  return {
    schemaVersion: SCHEMA_VERSION,
    eventId,
    batchId,
    signal,
    receivedAt: receivedAt.toISOString(),
    deliveryAttempt: 0,
    payload: sanitizedPayload,
  };
}

function canonicalizeScope(event, trustedScope) {
  if (!trustedScope) return event;
  return {
    ...event,
    service: trustedScope.service,
    env: trustedScope.environment,
    version: trustedScope.version ?? event.version,
  };
}

export function encodeOpenObserveBody(message) {
  return message.payload.map((event) => JSON.stringify(event)).join("\n");
}

function safeDecode(rawBody) {
  const text = Buffer.isBuffer(rawBody) ? rawBody.toString("utf8") : String(rawBody);
  if (text.includes("\u0000")) throw new AdmissionError(400, "invalid_encoding");
  const trimmed = text.trim();
  if (!trimmed) throw new AdmissionError(400, "empty_payload");
  try {
    return JSON.parse(trimmed);
  } catch {
    const lines = trimmed.split(/\r?\n/).filter(Boolean);
    if (lines.length === 0) throw new AdmissionError(400, "invalid_json");
    try {
      return lines.map((line) => JSON.parse(line));
    } catch {
      throw new AdmissionError(400, "invalid_json");
    }
  }
}

export function mapSanitizationError(error) {
  if (error instanceof AdmissionError) return error;
  if (error instanceof SanitizationError) {
    return new AdmissionError(400, error.code);
  }
  return new AdmissionError(400, "payload_rejected");
}
