// Pure stable-identity marker for starter dashboards. No I/O.
//
// docs/openobserve-v0.91-dashboard-capabilities.md capability #9a: a
// dashboard's own `dashboardId` is always server-assigned and never
// portable/predictable across a fresh OpenObserve instance, so dashboard-governance
// cannot pin a starter dashboard's identity to it the way stream-lifecycle pins
// `_rumdata`/`_rumlog` by stream name. Instead, a fixed marker string is
// embedded in the dashboard's `description` field on create and never
// touched again — install-starters/status/audit resolve "is this dashboard
// one of ours, and which starter is it" from the marker, not from the
// (unstable) id.

const MARKER_PATTERN = /\[chicek:starter:([a-z0-9-]+):v(\d+)\]/;
const STARTER_ID_PATTERN = /^[a-z0-9-]+$/;

export function buildMarker(starterId, starterVersion) {
  if (typeof starterId !== "string" || !STARTER_ID_PATTERN.test(starterId)) {
    throw new Error(`buildMarker: invalid starterId ${JSON.stringify(starterId)}`);
  }
  if (!Number.isInteger(starterVersion) || starterVersion < 1) {
    throw new Error(`buildMarker: invalid starterVersion ${JSON.stringify(starterVersion)}`);
  }
  return `[chicek:starter:${starterId}:v${starterVersion}]`;
}

export function parseMarker(description) {
  if (typeof description !== "string") return null;
  const match = description.match(MARKER_PATTERN);
  if (!match) return null;
  return { starterId: match[1], starterVersion: Number(match[2]) };
}

export function stripMarker(description) {
  if (typeof description !== "string") return "";
  return description.replace(MARKER_PATTERN, "").trim();
}

export function embedMarker(description, starterId, starterVersion) {
  const marker = buildMarker(starterId, starterVersion);
  const base = stripMarker(description ?? "");
  return base.length > 0 ? `${base} ${marker}` : marker;
}
