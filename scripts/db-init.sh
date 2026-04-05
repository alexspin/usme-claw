#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

: "${DATABASE_URL:=postgres://usme:usme_dev@localhost:5432/usme}"
export DATABASE_URL

echo "Running migrations against $DATABASE_URL ..."
cd "$REPO_ROOT/packages/usme-core"
npx node-pg-migrate up --migrations-dir db/migrations --database-url-var DATABASE_URL

echo "Migrations complete."
