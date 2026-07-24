#!/bin/sh
set -eu

export RABBITMQ_DEFAULT_USER="$(cat /run/secrets/rabbitmq_admin_username)"
export RABBITMQ_DEFAULT_PASS="$(cat /run/secrets/rabbitmq_admin_password)"
export RABBITMQ_DEFAULT_VHOST="/"
ready_file="/tmp/chicek-rabbitmq-ready"
rm -f "$ready_file"

docker-entrypoint.sh "$@" &
rabbit_pid="$!"

until rabbitmq-diagnostics -q check_running >/dev/null 2>&1; do
  sleep 2
done

create_user() {
  user_file="$1"
  pass_file="$2"
  tag="$3"
  configure="$4"
  write="$5"
  read="$6"

  user="$(cat "$user_file")"
  pass="$(cat "$pass_file")"

  if rabbitmqctl list_users --silent | awk '{print $1}' | grep -Fxq "$user"; then
    rabbitmqctl change_password "$user" "$pass" >/dev/null
  else
    rabbitmqctl add_user "$user" "$pass" >/dev/null
  fi
  rabbitmqctl set_user_tags "$user" "$tag" >/dev/null
  rabbitmqctl set_permissions -p / "$user" "$configure" "$write" "$read" >/dev/null
}

create_user \
  /run/secrets/rabbitmq_admin_username \
  /run/secrets/rabbitmq_admin_password \
  "administrator" \
  ".*" \
  ".*" \
  ".*"

create_user \
  /run/secrets/rabbitmq_ingest_username \
  /run/secrets/rabbitmq_ingest_password \
  "" \
  "^$" \
  "^chicek\\.frontend\\.telemetry$" \
  "^$"

create_user \
  /run/secrets/rabbitmq_worker_username \
  /run/secrets/rabbitmq_worker_password \
  "" \
  "^$" \
  "^chicek\\.frontend\\.telemetry$" \
  "^chicek\\.frontend\\..*"

create_user \
  /run/secrets/rabbitmq_monitoring_username \
  /run/secrets/rabbitmq_monitoring_password \
  "monitoring" \
  "^$" \
  "^$" \
  "^chicek\\.frontend\\..*"

touch "$ready_file"

wait "$rabbit_pid"
