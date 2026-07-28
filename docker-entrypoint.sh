#!/bin/sh

set -eu

data_directory="$(dirname "${NOTES_DB:-/app/data/notes.sqlite}")"

if [ "$(id -u)" -eq 0 ]; then
  mkdir -p "${data_directory}"
  chown 1000:1000 "${data_directory}"
  chmod 700 "${data_directory}"

  for database_file in \
    "${NOTES_DB:-/app/data/notes.sqlite}" \
    "${NOTES_DB:-/app/data/notes.sqlite}-shm" \
    "${NOTES_DB:-/app/data/notes.sqlite}-wal"
  do
    if [ -e "${database_file}" ]; then
      chown 1000:1000 "${database_file}"
      chmod 600 "${database_file}"
    fi
  done

  exec setpriv \
    --reuid=1000 \
    --regid=1000 \
    --init-groups \
    --bounding-set=-all \
    --inh-caps=-all \
    --ambient-caps=-all \
    --no-new-privs \
    "$@"
fi

exec "$@"
