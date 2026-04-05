#!/usr/bin/env bash
set -euo pipefail

CONTAINER=usme-db
IMAGE=timescale/timescaledb-ha:pg16

status=$(docker inspect "$CONTAINER" --format "{{.State.Status}}" 2>/dev/null || echo "missing")

case "$status" in
  running)
    echo "usme-db already running"
    exit 0
    ;;
  exited|created|paused)
    echo "Starting existing usme-db container..."
    docker start "$CONTAINER"
    ;;
  missing)
    echo "Creating usme-db container..."
    docker run -d \
      --name "$CONTAINER" \
      -e POSTGRES_DB=usme \
      -e POSTGRES_USER=usme \
      -e POSTGRES_PASSWORD=usme_dev \
      -p 5432:5432 \
      --restart unless-stopped \
      "$IMAGE"
    ;;
  *)
    echo "Unexpected container state: $status — removing and recreating..."
    docker rm -f "$CONTAINER" 2>/dev/null || true
    docker run -d \
      --name "$CONTAINER" \
      -e POSTGRES_DB=usme \
      -e POSTGRES_USER=usme \
      -e POSTGRES_PASSWORD=usme_dev \
      -p 5432:5432 \
      --restart unless-stopped \
      "$IMAGE"
    ;;
esac

# Wait for postgres to be ready
echo -n "Waiting for postgres..."
for i in $(seq 1 30); do
  if docker exec "$CONTAINER" pg_isready -U usme -q 2>/dev/null; then
    echo " ready! (${i}s)"
    exit 0
  fi
  echo -n "."
  sleep 1
done

echo " timed out after 30s"
exit 1
