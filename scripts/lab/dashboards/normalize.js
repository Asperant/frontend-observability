// Pure normalization/denormalization between OpenObserve's real dashboard
// envelope shape (docs/openobserve-v0.91-dashboard-capabilities.md
// capability #6/#14) and a portable, secret-free canonical JSON used for
// export/backup/import. No I/O.

// OpenObserve wraps the real body in a versioned envelope
// (`{v1..v8, version, hash, updatedAt, ...}`). Earlier pinned-build probes
// only observed v3, but the same v0.91 UI may round-trip some panel shapes
// as newer bodies such as v8. The repo authors portable starter dashboards;
// callers should read the active body instead of assuming one fixed slot.
export function extractDashboardBody(envelope) {
  if (!envelope || typeof envelope !== "object") {
    throw new Error("extractDashboardBody: expected a versioned dashboard envelope");
  }
  const preferred = Number.isInteger(envelope.version) ? envelope[`v${envelope.version}`] : null;
  if (preferred) return preferred;
  for (let version = 8; version >= 1; version -= 1) {
    const body = envelope[`v${version}`];
    if (body) return body;
  }
  throw new Error("extractDashboardBody: expected a populated dashboard body");
}

/**
 * Strips every server-only/volatile/non-portable field
 * (dashboardId, owner, created, and the list-view's flattened
 * folder_id/folder_name/dashboard_id/hash/updatedAt convenience fields —
 * capability #14) from a raw v3 dashboard body, leaving a canonical,
 * portable JSON shape safe to write to disk or hand to another environment.
 */
export function normalizeDashboardBody(v3Body) {
  return {
    schemaVersion: 1,
    version: v3Body.version,
    title: v3Body.title,
    description: v3Body.description,
    role: v3Body.role ?? "",
    tabs: v3Body.tabs ?? [],
    variables: v3Body.variables ?? { list: [] },
  };
}

/**
 * Builds a POST-ready create body from a normalized dashboard, for a brand
 * new dashboard in a folder that does not have it yet. `owner` is the
 * caller's own admin identity (never sourced from a normalized export, since
 * an export's original owner is not portable/meaningful in a new
 * environment).
 */
export function denormalizeForCreate(normalized, { owner, createdAt }) {
  return {
    version: normalized.version,
    dashboardId: "",
    title: normalized.title,
    description: normalized.description,
    role: normalized.role ?? "",
    owner,
    created: createdAt,
    tabs: normalized.tabs,
    variables: normalized.variables,
  };
}

/**
 * Builds a PUT-ready update body from a normalized dashboard plus the
 * existing (real, currently-installed) v3 body it is replacing — preserving
 * the existing dashboard's server-assigned identity (dashboardId/owner/
 * created), which a PUT must echo back (capability #8).
 */
export function denormalizeForUpdate(normalized, existingV3Body) {
  return {
    version: normalized.version,
    dashboardId: existingV3Body.dashboardId,
    title: normalized.title,
    description: normalized.description,
    role: normalized.role ?? "",
    owner: existingV3Body.owner,
    created: existingV3Body.created,
    tabs: normalized.tabs,
    variables: normalized.variables,
  };
}
