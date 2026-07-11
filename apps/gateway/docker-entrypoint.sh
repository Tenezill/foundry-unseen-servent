#!/bin/sh
set -e
# Idempotent players.yaml bootstrap: never overwrite a live install's hashes.
if [ -n "$PLAYERS_FILE" ] && [ ! -f "$PLAYERS_FILE" ]; then
  mkdir -p "$(dirname "$PLAYERS_FILE")"
  echo "players: []" > "$PLAYERS_FILE"
  echo "bootstrapped empty players file at $PLAYERS_FILE"
fi
exec "$@"
