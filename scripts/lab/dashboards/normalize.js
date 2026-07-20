// Pure normalization/denormalization between OpenObserve's real dashboard
// envelope shape (docs/openobserve-v0.91-dashboard-capabilities.md
// capability #6/#14) and a portable, secret-free canonical JSON used for
// export/backup/import. No I/O.

// The pinned build always wraps the real body in a versioned envelope
// (`{v1..v8, version, hash, updatedAt, ...}`) where only `v3` is ever
// populated (capability #6) — this repo only ever authors/reads v3.
export function extractDashboardBody(envelope) {
  if (!envelope || envelope.version !== 3 || !envelope.v3) {
    throw new Error("extractDashboardBody: expected a v3 dashboard envelope");
  }
  return envelope.v3;
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
