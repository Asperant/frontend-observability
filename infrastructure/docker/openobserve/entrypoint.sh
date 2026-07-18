#!/bin/sh
# Reads compose secret files, exports the two root-credential env vars the
# upstream OpenObserve binary expects on first boot, then execs the original
# /openobserve binary as PID 1 with no injected arguments. Never echoes the
# secret values themselves.
set -eu

email_file="${OPENOBSERVE_ROOT_EMAIL_FILE:-/run/secrets/openobserve_root_email}"
password_file="${OPENOBSERVE_ROOT_PASSWORD_FILE:-/run/secrets/openobserve_root_password}"

for secret_file in "$email_file" "$password_file"; do
  if [ -L "$secret_file" ]; then
    echo "entrypoint: refusing symlinked secret file: $secret_file" >&2
    exit 1
  fi
  if [ ! -s "$secret_file" ]; then
    echo "entrypoint: required secret file missing or empty: $secret_file" >&2
    exit 1
  fi
done

ZO_ROOT_USER_EMAIL="$(cat "$email_file")"
ZO_ROOT_USER_PASSWORD="$(cat "$password_file")"
export ZO_ROOT_USER_EMAIL
export ZO_ROOT_USER_PASSWORD

exec /openobserve
