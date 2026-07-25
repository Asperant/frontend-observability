import { encodeOpenObserveBody } from "./payload.js";

export function openObservePath(signal) {
  return signal === "rum" ? "/rum/v1/default/rum" : "/rum/v1/default/logs";
}

export async function deliverToOpenObserve(message, { baseUrl, rumToken, timeoutMs = 10_000 }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const url = new URL(openObservePath(message.signal), baseUrl);
    url.searchParams.set("o2-api-key", rumToken);
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=UTF-8" },
      body: encodeOpenObserveBody(message),
      signal: controller.signal,
    });
    const responseText = await response.text().catch(() => "");
    return classifyOpenObserveResponse(response.status, responseText);
  } catch (error) {
    return {
      accepted: false,
      retryable: true,
      status: 0,
      reason: error?.name === "AbortError" ? "timeout" : "connection_error",
    };
  } finally {
    clearTimeout(timer);
  }
}

export function classifyOpenObserveResponse(status, body = "") {
  if (status >= 200 && status < 300) return { accepted: true, retryable: false, status };
  if (status === 408 || status === 429 || status >= 500) {
    return { accepted: false, retryable: true, status, reason: "transient_openobserve_failure" };
  }
  return {
    accepted: false,
    retryable: false,
    status,
    reason: `permanent_openobserve_rejection:${String(body).slice(0, 80)}`,
  };
}
