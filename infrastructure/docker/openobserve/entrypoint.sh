#!/bin/sh
# Reads compose secret files, exports the root-credential and RUM
# client-token env vars the upstream OpenObserve binary expects on first
# boot, then execs the original /openobserve binary as PID 1 with no
# injected arguments. Never echoes the secret values themselves.
set -eu

email_file="${OPENOBSERVE_ROOT_EMAIL_FILE:-/run/secrets/openobserve_root_email}"
password_file="${OPENOBSERVE_ROOT_PASSWORD_FILE:-/run/secrets/openobserve_root_password}"
rum_client_token_file="${OPENOBSERVE_RUM_CLIENT_TOKEN_FILE:-/run/secrets/openobserve_rum_client_token}"

for secret_file in "$email_file" "$password_file" "$rum_client_token_file"; do
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
ZO_RUM_CLIENT_TOKEN="$(cat "$rum_client_token_file")"
export ZO_ROOT_USER_EMAIL
export ZO_ROOT_USER_PASSWORD
export ZO_RUM_CLIENT_TOKEN

exec /openobserve
