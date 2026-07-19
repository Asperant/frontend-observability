import { randomBytes, randomInt } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";

import {
  atomicWriteFile,
  emailSecretPath,
  fileMode,
  isWorldOrGroupReadableSecret,
  passwordSecretPath,
  rejectSymlink,
  rumClientTokenSecretPath,
  secretsDir,
} from "./common.mjs";

const PASSWORD_LENGTH = 44;
const LOWER = "abcdefghijklmnopqrstuvwxyz";
const UPPER = LOWER.toUpperCase();
const DIGITS = "0123456789";
const SPECIAL = "!@#$%^&*()-_=+";
const ALL = LOWER + UPPER + DIGITS + SPECIAL;
const RUM_CLIENT_TOKEN_BYTES = 32;

function pick(alphabet) {
  return alphabet[randomInt(alphabet.length)];
}

/**
 * A cryptographically-random placeholder for the RUM client token secret
 * file. OpenObserve does not accept an operator-chosen value for real RUM
 * ingestion authorization: it validates the incoming token against a
 * specific user's server-generated `rum_token`, fetched via the admin-only
 * `GET /api/{org}/rumtoken` (see scripts/lab/fetch-rum-token.mjs). This
 * placeholder only exists so the secret file — and therefore the Docker
 * secret bind mount that requires it — is present for the very first
 * `docker compose up`; scripts/lab/up.mjs overwrites it with the real,
 * fetched token as soon as openobserve is healthy, exactly once per lab
 * lifetime (`lab:purge` resets it).
 */
export function generateRumClientToken() {
  return randomBytes(RUM_CLIENT_TOKEN_BYTES).toString("hex");
}

/**
 * At least 32 bytes of cryptographically secure entropy, guaranteed to
 * satisfy OpenObserve's root-password policy (8-128 chars, at least one
 * lower/upper/digit/special character).
 */
export function generatePassword() {
  const chars = [pick(LOWER), pick(UPPER), pick(DIGITS), pick(SPECIAL)];
  while (chars.length < PASSWORD_LENGTH) {
    chars.push(pick(ALL));
  }
  for (let i = chars.length - 1; i > 0; i -= 1) {
    const j = randomInt(i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join("");
}

export function generateEmail() {
  const suffix = randomInt(1_000_000, 9_999_999).toString(36);
  return `root-${suffix}@chicek-lab.invalid`;
}

function assertSecretFileIsSafe(path) {
  rejectSymlink(path);
  if (isWorldOrGroupReadableSecret(path)) {
    throw new Error(
      `refusing to reuse world/group-readable secret file: ${path}. ` +
        `Remove it and re-run lab:init to regenerate it with 0600 permissions.`,
    );
  }
}

/**
 * Idempotent: an existing, safely-permissioned, non-empty secret file is
 * left untouched. Only missing secrets are (re)generated.
 */
export function ensureSecrets() {
  mkdirSync(secretsDir, { recursive: true, mode: 0o700 });

  const results = { emailCreated: false, passwordCreated: false, rumClientTokenCreated: false };

  if (existsSync(emailSecretPath)) {
    assertSecretFileIsSafe(emailSecretPath);
    if (readFileSync(emailSecretPath, "utf8").length === 0) {
      throw new Error(`existing secret file is empty: ${emailSecretPath}`);
    }
  } else {
    atomicWriteFile(emailSecretPath, generateEmail(), { mode: 0o600 });
    results.emailCreated = true;
  }

  if (existsSync(passwordSecretPath)) {
    assertSecretFileIsSafe(passwordSecretPath);
    if (readFileSync(passwordSecretPath, "utf8").length === 0) {
      throw new Error(`existing secret file is empty: ${passwordSecretPath}`);
    }
  } else {
    atomicWriteFile(passwordSecretPath, generatePassword(), { mode: 0o600 });
    results.passwordCreated = true;
  }

  if (existsSync(rumClientTokenSecretPath)) {
    assertSecretFileIsSafe(rumClientTokenSecretPath);
    if (readFileSync(rumClientTokenSecretPath, "utf8").length === 0) {
      throw new Error(`existing secret file is empty: ${rumClientTokenSecretPath}`);
    }
  } else {
    atomicWriteFile(rumClientTokenSecretPath, generateRumClientToken(), { mode: 0o600 });
    results.rumClientTokenCreated = true;
  }

  assertSecretFileIsSafe(emailSecretPath);
  assertSecretFileIsSafe(passwordSecretPath);
  assertSecretFileIsSafe(rumClientTokenSecretPath);
  if (
    fileMode(emailSecretPath) !== 0o600 ||
    fileMode(passwordSecretPath) !== 0o600 ||
    fileMode(rumClientTokenSecretPath) !== 0o600
  ) {
    throw new Error("secret files must be exactly 0600 after generation.");
  }

  return results;
}
