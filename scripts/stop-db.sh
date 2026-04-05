#!/usr/bin/env bash
set -euo pipefail

CONTAINER=usme-db

status=$(docker inspect "$CONTAINER" --format "{{.State.Status}}" 2>/dev/null || echo "missing")

if [ "$status" = "missing" ]; then
  echo "usme-db container not found"
  exit 0
fi

if [ "$status" = "running" ]; then
  echo "Stopping usme-db..."
  docker stop "$CONTAINER"
  echo "usme-db stopped"
else
  echo "usme-db is not running (state: $status)"
fi
