import { ReasonCodes } from "../../diagnostics/reason-codes.js";
import { recordSanitization } from "../../diagnostics/counters.js";
import {
  SanitizationDecision,
  drop,
  isDrop,
  mergeDecision,
  uniqueReasons,
} from "../diagnostics/results.js";
import { SANITIZATION_POLICY_VERSION } from "../policy/baseline.js";
import { sanitizeActionName } from "./action.js";
import { sanitizeAttributes } from "./attributes.js";
import { sanitizeStack } from "./error.js";
import { sanitizeResource } from "./resource.js";
import { sanitizeString } from "./string.js";
import { sanitizeUrl } from "./url.js";

const KNOWN_RUM_TYPES = Object.freeze([
  "view",
  "action",
  "resource",
  "error",
  "long_task",
  "vital",
]);
const GENERIC_INTERACTION_NAMES = Object.freeze({
  click: "interaction.click",
  tap: "interaction.click",
  scroll: "interaction.click",
  application_start: "interaction.submit",
  back: "interaction.click",
});

export function sanitizeRumEvent(event, { counters, policy } = {}) {
  return runEventSanitizer(counters, () => {
    if (!event || typeof event !== "object" || !KNOWN_RUM_TYPES.includes(event.type)) {
      return drop(ReasonCodes.UNKNOWN_EVENT_TYPE);
    }
    const results = [];
    applyCommonEventFields(event, policy, results);

    if (event.type === "view") sanitizeViewEvent(event, policy, results);
    if (event.type === "action") sanitizeActionEvent(event, results);
    if (event.type === "resource") sanitizeResourceEvent(event, policy, results);
    if (event.type === "error") sanitizeErrorEvent(event, policy, results);
    if (event.type === "long_task") sanitizeLongTaskEvent(event, policy, results);
    if (event.type === "vital") sanitizeVitalEvent(event, results);

    if (results.some(isDrop)) return results.find(isDrop);
    event.context = buildSafeContext(event.context, results);
    event._frontend_observability_sanitization_policy = SANITIZATION_POLICY_VERSION;
    return { decision: mergeDecision(results), value: event, reasons: uniqueReasons(results) };
  });
}

export function sanitizeLogEvent(event, { counters, policy } = {}) {
  return runEventSanitizer(counters, () => {
    if (!event || typeof event !== "object") return drop(ReasonCodes.UNKNOWN_EVENT_TYPE);
    const results = [];
    applyCommonEventFields(event, policy, results);
    if (typeof event.message === "string") {
      const message = sanitizeString(event.message, { maxLength: 512 });
      if (isDrop(message)) return message;
      event.message = message.value;
      results.push(message);
    }
    if (event.error) sanitizeErrorPayload(event.error, policy, results);
    if (event.http?.url) {
      const url = sanitizeUrl(event.http.url, { policy });
      if (isDrop(url)) return url;
      event.http.url = url.value;
      results.push(url);
    }
    delete event.usr;
    delete event.account;
    event.context = buildSafeContext(event.context, results);
    event._frontend_observability_sanitization_policy = SANITIZATION_POLICY_VERSION;
    return { decision: mergeDecision(results), value: event, reasons: uniqueReasons(results) };
  });
}

function runEventSanitizer(counters, callback) {
  let result;
  try {
    result = callback();
  } catch {
    result = drop(ReasonCodes.SANITIZER_FAILURE);
  }
  recordSanitization(counters, result.decision, result.reasons);
  return result.decision === SanitizationDecision.DROP ? false : undefined;
}

function applyCommonEventFields(event, policy, results) {
  delete event.usr;
  delete event.account;
  delete event.user;
  delete event.headers;
  delete event.request;
  delete event.response;
  delete event.body;
  delete event.payload;
  if (event.view?.url) {
    const url = sanitizeUrl(event.view.url, { policy });
    if (isDrop(url)) {
      event.view.url = "/";
      results.push({ decision: "redact", reasons: url.reasons });
    } else {
      event.view.url = url.value;
      results.push(url);
    }
  }
  if (event.view?.referrer) {
    const referrer = sanitizeUrl(event.view.referrer, { policy });
    if (isDrop(referrer)) delete event.view.referrer;
    else event.view.referrer = referrer.value;
    results.push(referrer);
  }
  if (event.view?.name) {
    const name = sanitizeString(event.view.name, { maxLength: 128 });
    if (isDrop(name)) delete event.view.name;
    else event.view.name = name.value;
    results.push(name);
  }
}

function sanitizeViewEvent(event, policy, results) {
  const lcpUrl = event.view?.performance?.lcp?.resource_url;
  if (lcpUrl) {
    const url = sanitizeUrl(lcpUrl, { policy, resource: true });
    if (isDrop(url)) delete event.view.performance.lcp.resource_url;
    else event.view.performance.lcp.resource_url = url.value;
    results.push(url);
  }
}

function sanitizeActionEvent(event, results) {
  const actionType = event.action?.type;
  const targetName = event.action?.target?.name;
  if (actionType !== "custom") {
    event.action.target = { name: GENERIC_INTERACTION_NAMES[actionType] ?? "interaction.click" };
    results.push({ decision: "redact", reasons: [ReasonCodes.PII_REDACTED] });
    return;
  }
  const name = sanitizeActionName(targetName);
  if (isDrop(name)) results.push(name);
  else {
    event.action.target.name = name.value;
    results.push(name);
  }
}

function sanitizeResourceEvent(event, policy, results) {
  const resource = sanitizeResource(event.resource, { policy });
  if (isDrop(resource)) results.push(resource);
  else {
    event.resource.url = resource.value;
    results.push(resource);
  }
  if (event.resource?.graphql) {
    delete event.resource.graphql.variables;
    results.push({ decision: "redact", reasons: [ReasonCodes.ATTRIBUTE_VALUE_UNSAFE] });
  }
}

function sanitizeErrorEvent(event, policy, results) {
  sanitizeErrorPayload(event.error, policy, results);
}

function sanitizeErrorPayload(error, policy, results) {
  if (!error || typeof error !== "object") return;
  if (typeof error.message === "string") {
    const message = sanitizeString(error.message, { maxLength: 512 });
    if (isDrop(message)) results.push(message);
    else error.message = message.value;
    results.push(message);
  }
  for (const key of ["stack", "handling_stack", "component_stack"]) {
    if (typeof error[key] !== "string") continue;
    const stack = sanitizeStack(error[key]);
    if (isDrop(stack)) results.push(stack);
    else error[key] = stack.value;
    results.push(stack);
  }
  if (error.resource?.url) {
    const url = sanitizeUrl(error.resource.url, { policy });
    if (isDrop(url)) results.push(url);
    else error.resource.url = url.value;
    results.push(url);
  }
  if (Array.isArray(error.causes)) {
    error.causes = error.causes.slice(0, 3).map((cause) => sanitizeCause(cause, results));
  }
}

function sanitizeCause(cause, results) {
  if (!cause || typeof cause !== "object") return {};
  const output = {};
  for (const key of ["message", "stack", "type", "source"]) {
    if (typeof cause[key] !== "string") continue;
    const sanitized =
      key === "stack" ? sanitizeStack(cause[key]) : sanitizeString(cause[key], { maxLength: 512 });
    if (!isDrop(sanitized)) output[key] = sanitized.value;
    results.push(sanitized);
  }
  return output;
}

function sanitizeLongTaskEvent(event, policy, results) {
  for (const script of event.long_task?.scripts ?? []) {
    if (script.source_url) {
      const url = sanitizeUrl(script.source_url, { policy, resource: true });
      if (isDrop(url)) delete script.source_url;
      else script.source_url = url.value;
      results.push(url);
    }
    if (script.invoker) {
      const invoker = sanitizeString(script.invoker, { maxLength: 128 });
      if (isDrop(invoker)) delete script.invoker;
      else script.invoker = invoker.value;
      results.push(invoker);
    }
  }
}

function sanitizeVitalEvent(event, results) {
  const vital = event.vital ?? {};
  for (const key of ["name", "step_type", "operation_key", "failure_reason", "description"]) {
    if (typeof vital[key] !== "string") continue;
    const result = sanitizeString(vital[key], { maxLength: 128 });
    if (isDrop(result)) results.push(result);
    else vital[key] = result.value;
    results.push(result);
  }
}

function buildSafeContext(context, results) {
  const result = sanitizeAttributes(context, { maxBytes: 4 * 1024, maxItems: 12 });
  results.push(result);
  return isDrop(result) ? undefined : result.value;
}
