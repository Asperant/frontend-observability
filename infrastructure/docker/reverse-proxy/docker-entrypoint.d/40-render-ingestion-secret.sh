#!/bin/sh
set -eu

token_file="${OPENOBSERVE_RUM_CLIENT_TOKEN_FILE:-/run/secrets/openobserve_rum_client_token}"
template="/etc/chicek/templates/ingestion-upstream-secret.conf.template"
target="/tmp/ingestion-upstream-secret.conf"

if [ -L "$token_file" ]; then
  echo "entrypoint: refusing symlinked RUM token file" >&2
  exit 1
fi

if [ ! -s "$token_file" ]; then
  echo "entrypoint: required RUM token file missing or empty" >&2
  exit 1
fi

OPENOBSERVE_RUM_CLIENT_TOKEN="$(cat "$token_file")"
case "$OPENOBSERVE_RUM_CLIENT_TOKEN" in
  *[!A-Za-z0-9._~-]*)
    echo "entrypoint: RUM token contains unsupported URL characters" >&2
    exit 1
    ;;
esac

export OPENOBSERVE_RUM_CLIENT_TOKEN
envsubst '${OPENOBSERVE_RUM_CLIENT_TOKEN}' < "$template" > "$target"
chmod 0600 "$target"
