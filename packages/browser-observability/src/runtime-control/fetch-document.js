import {
  CONTROL_ENDPOINT_PATH,
  CONTROL_FETCH_TIMEOUT_MS,
  MAX_CONTROL_BODY_BYTES,
} from "./constants.js";
import { hasDuplicateObjectKeys } from "./duplicate-keys.js";
import {
  ControlReasonCodes,
  validateControlDocumentShape,
  validateControlLifetime,
} from "./validate-document.js";

// Transport/HTTP-layer failures — distinct from ControlReasonCodes, which is
// reserved for a document that was received but rejected on its own merits
// (schema, duplicate/unknown key, revision, lifetime). apply-document.js
// uses that distinction to route these into `refreshFailed` instead of
// `invalidRejected`.
export const ControlTransportReasonCodes = Object.freeze({
  HTTP_ERROR: "CONTROL_HTTP_ERROR",
  CONTENT_TYPE_INVALID: "CONTROL_CONTENT_TYPE_INVALID",
  TOO_LARGE: "CONTROL_TOO_LARGE",
  JSON_INVALID: "CONTROL_JSON_INVALID",
  TIMEOUT: "CONTROL_TIMEOUT",
  UNAVAILABLE: "CONTROL_UNAVAILABLE",
});

/**
 * Fetches and fully validates one runtime-control document. Every failure
 * path returns `{ ok: false, reasonCode }` and never throws — callers never
 * need a try/catch. Deliberately mirrors config/load-config.js's bounded
 * fetch (timeout, same-origin exact GET, no-store, referrer-free, redirect
 * refused, max byte cap) but is otherwise fully independent of it: the two
 * documents have different schemas and different security properties.
 */
export async function fetchControlDocument({ signal, now = new Date() } = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), CONTROL_FETCH_TIMEOUT_MS);
  const abortOnParent = () => controller.abort();
  signal?.addEventListener("abort", abortOnParent, { once: true });

  try {
    const response = await globalThis.fetch(CONTROL_ENDPOINT_PATH, {
      method: "GET",
      credentials: "omit",
      cache: "no-store",
      redirect: "error",
      referrerPolicy: "no-referrer",
      headers: { Accept: "application/json" },
      signal: controller.signal,
    });

    if (response.status !== 200 || response.redirected) {
      return { ok: false, reasonCode: ControlTransportReasonCodes.HTTP_ERROR };
    }
    if (!isJsonContentType(response.headers?.get?.("content-type"))) {
      return { ok: false, reasonCode: ControlTransportReasonCodes.CONTENT_TYPE_INVALID };
    }

    const bodyResult = await readBoundedBody(response);
    if (!bodyResult.ok) return bodyResult;

    if (hasDuplicateObjectKeys(bodyResult.body)) {
      return { ok: false, reasonCode: ControlReasonCodes.DUPLICATE_KEY };
    }

    let document;
    try {
      document = JSON.parse(bodyResult.body);
    } catch {
      return { ok: false, reasonCode: ControlTransportReasonCodes.JSON_INVALID };
    }

    const shape = validateControlDocumentShape(document);
    if (!shape.valid) return { ok: false, reasonCode: shape.reasonCode };

    const lifetime = validateControlLifetime(document, now);
    if (!lifetime.valid) return { ok: false, reasonCode: lifetime.reasonCode };

    return { ok: true, document };
  } catch (error) {
    if (controller.signal.aborted && !signal?.aborted) {
      return { ok: false, reasonCode: ControlTransportReasonCodes.TIMEOUT };
    }
    if (error?.name === "AbortError") {
      return { ok: false, reasonCode: ControlTransportReasonCodes.TIMEOUT };
    }
    return { ok: false, reasonCode: ControlTransportReasonCodes.UNAVAILABLE };
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", abortOnParent);
  }
}

function isJsonContentType(contentType) {
  if (typeof contentType !== "string") return false;
  const type = contentType.split(";")[0].trim().toLowerCase();
  return type === "application/json" || type.endsWith("+json");
}

async function readBoundedBody(response) {
  if (response.body?.getReader) {
    const reader = response.body.getReader();
    const chunks = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_CONTROL_BODY_BYTES) {
        await reader.cancel();
        return { ok: false, reasonCode: ControlTransportReasonCodes.TOO_LARGE };
      }
      chunks.push(value);
    }
    return { ok: true, body: new TextDecoder().decode(concatChunks(chunks, total)) };
  }

  const body = await response.text();
  if (new TextEncoder().encode(body).byteLength > MAX_CONTROL_BODY_BYTES) {
    return { ok: false, reasonCode: ControlTransportReasonCodes.TOO_LARGE };
  }
  return { ok: true, body };
}

function concatChunks(chunks, total) {
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}
