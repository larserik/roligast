#!/usr/bin/env bash
# Reads the sign-in log in the running container.
#
#   ./scripts/logins.sh              everything at a glance
#   ./scripts/logins.sh ips 30       where the traffic came from, last 30 days
#   ./scripts/logins.sh help         the rest of the commands
#
# Runs from anywhere in the repo; against a local database, use
# DATABASE_PATH=./data/roligast.db node scripts/logins.js instead.
set -euo pipefail
cd "$(dirname "$0")/.."
exec docker compose exec -T roligast node scripts/logins.js "$@"
