#!/usr/bin/env bash
# Rebuild a scratch database from db/*.sql and compare its schema with the live nipunacrm database.
# Usage (from the repo root): bash .claude/skills/db-migration/scripts/replay_check.sh
set -euo pipefail

REPO="$(cd "$(dirname "$0")/../../../.." && pwd)"
LIVE_DB="${LIVE_DB:-nipunacrm}"
REPLAY_DB="${LIVE_DB}_replay"
TMP="$(mktemp -d)"

dropdb --if-exists "$REPLAY_DB" >/dev/null 2>&1
createdb "$REPLAY_DB"
trap 'dropdb --if-exists "$REPLAY_DB" >/dev/null 2>&1; rm -rf "$TMP"' EXIT

for f in "$REPO"/db/0*.sql; do
  psql -d "$REPLAY_DB" -v ON_ERROR_STOP=1 -1 -q -f "$f" || { echo "FAILED applying $(basename "$f")"; exit 1; }
done

# \restrict lines carry a random per-dump token; comments and blank lines are noise
pg_dump -s --no-owner "$LIVE_DB"   | grep -v '^--\|restrict' | sed '/^$/d' > "$TMP/live.sql"
pg_dump -s --no-owner "$REPLAY_DB" | grep -v '^--\|restrict' | sed '/^$/d' > "$TMP/replay.sql"

if diff "$TMP/live.sql" "$TMP/replay.sql" > "$TMP/schema.diff"; then
  echo "replay OK · schema diff lines: 0"
else
  echo "schema diff lines: $(wc -l < "$TMP/schema.diff")"
  head -60 "$TMP/schema.diff"
  exit 1
fi
