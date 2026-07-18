#!/bin/sh
# Real HTTP healthcheck against the upstream OpenObserve /healthz endpoint,
# not a bare port-open check.
set -eu

port="${ZO_HTTP_PORT:-5080}"

exec wget -q -O /dev/null "http://127.0.0.1:${port}/healthz"
