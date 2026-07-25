#!/bin/sh
set -eu

target="/tmp/ingestion-upstream-secret.conf"

printf '# Durable ingestion path: no OpenObserve token is rendered in the proxy.\n' > "$target"
chmod 0600 "$target"
