/**
 * Pure, side-effect-free toolchain version comparison logic, kept separate
 * from check-toolchain.js's filesystem/process reads so it can be unit
 * tested without touching disk or spawning a subprocess.
 */

export function parseSemver(raw) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(String(raw ?? "").trim());
  if (!match) return null;
  const [, major, minor, patch] = match;
  return { major, minor, patch, full: `${major}.${minor}.${patch}` };
}

/**
 * Exact major.minor.patch match only — a different minor or patch version
 * is rejected, not just a different major version.
 */
export function checkExactNodeVersion(expectedRaw, actualRaw) {
  const expected = parseSemver(expectedRaw);
  if (!expected) {
    return {
      ok: false,
      message: `Invalid .node-version content: "${expectedRaw}". Expected an exact major.minor.patch version.`,
    };
  }
  const actual = parseSemver(actualRaw);
  if (!actual) {
    return { ok: false, message: `Unable to parse the running Node.js version: "${actualRaw}".` };
  }
  if (expected.full !== actual.full) {
    return {
      ok: false,
      message: `Node.js version mismatch: expected ${expected.full} (.node-version), found ${actual.full} (process.version).`,
    };
  }
  return { ok: true, expected: expected.full, actual: actual.full };
}

/**
 * Compares the running `pnpm --version` output against the exact version
 * pinned in package.json's `packageManager` field (e.g.
 * "pnpm@11.15.0+sha512....", where the "+..." integrity suffix is not a
 * version component and is stripped before comparison).
 */
export function checkExactPnpmVersion(packageManagerField, actualRaw) {
  if (!packageManagerField) {
    return {
      ok: false,
      message: "package.json is missing a pinned packageManager field for pnpm.",
    };
  }
  const afterAt = packageManagerField.split("@")[1];
  const expectedVersion = afterAt?.split("+")[0];
  const expected = parseSemver(expectedVersion);
  if (!expected) {
    return {
      ok: false,
      message: `Invalid pnpm version in package.json packageManager field: "${packageManagerField}".`,
    };
  }
  const actual = parseSemver(actualRaw);
  if (!actual) {
    return { ok: false, message: `Unable to parse the running pnpm version: "${actualRaw}".` };
  }
  if (expected.full !== actual.full) {
    return {
      ok: false,
      message: `pnpm version mismatch: expected ${expected.full} (package.json packageManager), found ${actual.full} (pnpm --version).`,
    };
  }
  return { ok: true, expected: expected.full, actual: actual.full };
}
