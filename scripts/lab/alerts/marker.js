const MARKER_PREFIX = "CHICEK_STAGE17_ALERT";

export function buildMarker({ starterId, starterVersion }) {
  return `${MARKER_PREFIX} starterId=${starterId} starterVersion=${starterVersion}`;
}

export function parseMarker(description) {
  if (typeof description !== "string" || !description.includes(MARKER_PREFIX)) return null;
  const starterId = description.match(/starterId=([a-z0-9-]+)/)?.[1];
  const starterVersion = Number(description.match(/starterVersion=([0-9]+)/)?.[1]);
  if (!starterId || !Number.isInteger(starterVersion)) return null;
  return { starterId, starterVersion };
}
