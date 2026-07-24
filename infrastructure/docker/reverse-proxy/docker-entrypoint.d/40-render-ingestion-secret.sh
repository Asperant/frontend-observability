#!/bin/sh
set -eu

target="/tmp/ingestion-upstream-secret.conf"

printf '# Stage 20.5 durable ingestion path: no OpenObserve token is rendered in the proxy.\n' > "$target"
chmod 0600 "$target"
