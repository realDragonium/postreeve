#!/bin/sh
# Starts as root only to give the unprivileged bun user its data and backup directories (bind mounts and fresh
# volumes arrive owned by root), then drops to bun before running the command.
set -eu

if [ "$(id -u)" = "0" ]; then
  for directory in "$(dirname "${POSTREEVE_DB_PATH:-/app/data/postreeve.sqlite}")" ${POSTREEVE_BACKUP_DIR:-}; do
    mkdir -p "$directory"
    if [ "$(stat -c %u "$directory")" != "$(id -u bun)" ]; then chown -R bun:bun "$directory"; fi
  done
  exec setpriv --reuid=bun --regid=bun --init-groups -- "$@"
fi

exec "$@"
