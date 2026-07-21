export const POLICY_STATUS = Object.freeze({
  HEALTHY: "HEALTHY",
  PENDING: "PENDING",
  FIRING: "FIRING",
  RESOLVED: "RESOLVED",
  NO_DATA: "NO_DATA",
  QUERY_ERROR: "QUERY_ERROR",
  INSUFFICIENT_SAMPLE: "INSUFFICIENT_SAMPLE",
});

const SEVERITIES = new Set(["critical", "high", "medium", "low"]);
const REQUIRED_POLICY_KEYS = [
  "id",
  "name",
  "description",
  "metricId",
  "queryId",
  "stream",
  "severity",
  "enabledByDefault",
  "requiredScope",
  "evaluation",
  "threshold",
  "sample",
  "breach",
  "cooldown",
  "deduplicationKey",
  "recoveryCondition",
  "noDataPolicy",
  "queryErrorPolicy",
  "destinationRef",
  "dashboardRef",
  "runbookRef",
  "owner",
  "productionDecision",
];

export function validateAlertPolicy(
  policy,
  { knownMetricIds, knownQueryIds, knownDestinationRefs },
) {
  const errors = [];
  for (const key of REQUIRED_POLICY_KEYS) {
    if (!Object.hasOwn(policy, key)) errors.push(`missing required key: ${key}`);
  }
  if (!SEVERITIES.has(policy.severity)) errors.push("severity must be critical/high/medium/low");
  if (policy.enabledByDefault !== false) errors.push("starter alerts must be disabled by default");
  if (policy.noDataPolicy !== "NOT_HEALTHY") errors.push("NO_DATA must not be healthy");
  if (policy.queryErrorPolicy !== "NOT_HEALTHY") errors.push("QUERY_ERROR must not be healthy");
  if (!knownMetricIds.has(policy.metricId)) errors.push(`unknown metricId: ${policy.metricId}`);
  if (!knownQueryIds.has(policy.queryId)) errors.push(`unknown queryId: ${policy.queryId}`);
  if (!knownDestinationRefs.has(policy.destinationRef)) {
    errors.push(`unknown destinationRef: ${policy.destinationRef}`);
  }
  if (
    !Number.isInteger(policy.evaluation?.intervalMinutes) ||
    policy.evaluation.intervalMinutes < 1
  ) {
    errors.push("evaluation.intervalMinutes must be >= 1");
  }
  if (
    !Number.isInteger(policy.evaluation?.lookbackMinutes) ||
    policy.evaluation.lookbackMinutes < 1
  ) {
    errors.push("evaluation.lookbackMinutes must be >= 1");
  }
  if (policy.evaluation?.lookbackMinutes > 168 * 60) {
    errors.push("lookback exceeds 168h ceiling");
  }
  if (!policy.sample || !sampleMinimum(policy)) errors.push("minimum sample is required");
  if (!Number.isInteger(policy.breach?.requiredConsecutiveBreaches)) {
    errors.push("required consecutive breaches is required");
  }
  if (!Number.isInteger(policy.cooldown?.minutes) || policy.cooldown.minutes < 1) {
    errors.push("cooldown.minutes must be >= 1");
  }
  if (!policy.recoveryCondition) errors.push("recovery condition is required");
  const claimScanCopy = structuredClone(policy);
  delete claimScanCopy.doesNotClaim;
  if (JSON.stringify(claimScanCopy).match(/session.?replay|guaranteed.?delivery|no event loss/i)) {
    errors.push("policy must not claim Session Replay or guaranteed delivery");
  }
  return { valid: errors.length === 0, errors };
}

export function sampleMinimum(policy) {
  return (
    policy.sample?.minimum ??
    Math.min(policy.sample?.minimumCurrent ?? 0, policy.sample?.minimumBaseline ?? 0)
  );
}

function thresholdValue(policy) {
  return policy.threshold.starterValue ?? policy.threshold.absoluteStarterValue;
}

function measuredValue(policy, row) {
  if (policy.id === "telemetry-freshness") return row.ageMinutes;
  return row[policy.metricId] ?? row.p75 ?? null;
}

function hasMinimumSample(policy, row) {
  if (policy.id === "telemetry-freshness")
    return row.last_event_us != null || row.ageMinutes != null;
  return Number(row[policy.sample.field] ?? 0) >= policy.sample.minimum;
}

function breaches(policy, row) {
  const value = measuredValue(policy, row);
  if (value === null || value === undefined || Number.isNaN(Number(value))) return false;
  if (policy.threshold.direction === "above") return value > thresholdValue(policy);
  return false;
}

function recovers(policy, row) {
  const value = measuredValue(policy, row);
  if (value === null || value === undefined || Number.isNaN(Number(value))) return false;
  if (policy.recoveryCondition.direction === "below_or_equal") {
    return value <= policy.recoveryCondition.value;
  }
  return row.observedWithinCompanyWindow === true;
}

export function createAlertState() {
  return {
    status: POLICY_STATUS.HEALTHY,
    consecutiveBreaches: 0,
    consecutiveHealthy: 0,
    lastNotificationAtMinute: null,
    openDedupKey: null,
    notifications: [],
  };
}

export function evaluatePolicySample(policy, sample, state = createAlertState()) {
  if (sample.queryError) {
    state.status = POLICY_STATUS.QUERY_ERROR;
    return { state, notification: null };
  }
  if (sample.noData) {
    state.status = POLICY_STATUS.NO_DATA;
    return { state, notification: null };
  }
  if (!hasMinimumSample(policy, sample.row)) {
    state.status = POLICY_STATUS.INSUFFICIENT_SAMPLE;
    state.consecutiveBreaches = 0;
    return { state, notification: null };
  }

  const nowMinute = sample.nowMinute ?? 0;
  const dedupKey = sample.dedupKey ?? policy.deduplicationKey;
  const isBreach = breaches(policy, sample.row);
  const isRecovery = recovers(policy, sample.row);
  let notification = null;

  if (isBreach) {
    state.consecutiveBreaches += 1;
    state.consecutiveHealthy = 0;
    const enoughBreaches = state.consecutiveBreaches >= policy.breach.requiredConsecutiveBreaches;
    const cooldownElapsed =
      state.lastNotificationAtMinute === null ||
      nowMinute - state.lastNotificationAtMinute >= policy.cooldown.minutes;
    if (enoughBreaches && state.openDedupKey !== dedupKey && cooldownElapsed) {
      state.status = POLICY_STATUS.FIRING;
      state.openDedupKey = dedupKey;
      state.lastNotificationAtMinute = nowMinute;
      notification = { type: "firing", dedupKey };
      state.notifications.push(notification);
    } else {
      state.status = enoughBreaches ? POLICY_STATUS.FIRING : POLICY_STATUS.PENDING;
    }
    return { state, notification };
  }

  state.consecutiveBreaches = 0;
  if (state.openDedupKey && isRecovery) {
    state.consecutiveHealthy += 1;
    if (state.consecutiveHealthy >= policy.recoveryCondition.requiredConsecutiveHealthy) {
      notification = { type: "resolved", dedupKey: state.openDedupKey };
      state.notifications.push(notification);
      state.status = POLICY_STATUS.RESOLVED;
      state.openDedupKey = null;
      return { state, notification };
    }
  }
  state.status = POLICY_STATUS.HEALTHY;
  return { state, notification };
}

export function normalizeAlertExport(alert) {
  const copy = structuredClone(alert);
  delete copy.id;
  delete copy.uuid;
  delete copy.alert_id;
  delete copy.updated_at;
  delete copy.created_at;
  delete copy.last_triggered_at;
  if (copy.url) copy.url = "[redacted-runtime-url]";
  if (copy.headers) {
    copy.headers = Object.fromEntries(
      Object.keys(copy.headers).map((key) => [
        key,
        key.toLowerCase() === "content-type" ? copy.headers[key] : "[redacted]",
      ]),
    );
  }
  return copy;
}
