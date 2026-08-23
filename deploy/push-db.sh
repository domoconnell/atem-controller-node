#!/usr/bin/env bash
# Push the FULL local database to the Pi, replacing the Pi's.
#
# The normal deploy PROTECTS data/ on the Pi (so looks/mics captured there
# survive), which means your local connector config never goes over. Use this
# once to SEED a fresh Pi — or whenever you want the Pi to take your local
# config (connectors, looks, surfaces, mics, services, recorders).
#
#   ./deploy/push-db.sh                    # → pi@10.10.10.33
#   ./deploy/push-db.sh pi@10.10.10.99     # other target
#
# It stops the service (to release the SQLite file), checkpoints + copies the DB,
# clears stale WAL, then restarts. SSH multiplexing means the password is asked
# once. THIS OVERWRITES THE PI'S DATABASE — anything captured only on the Pi is lost.
set -euo pipefail

PI="${1:-pi@10.10.10.33}"
APP_DIR="/home/pi/atem-controller"
PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
DB="$PROJECT_DIR/data/stageit.db"
CTRL="/tmp/atemcn-ssh-%r@%h"
SSH_OPTS=(-o ControlMaster=auto -o "ControlPath=$CTRL" -o ControlPersist=600 -o StrictHostKeyChecking=accept-new)

[ -f "$DB" ] || { echo "ERROR: $DB not found" >&2; exit 1; }
count=$(sqlite3 "$DB" 'SELECT COUNT(*) FROM instances;' 2>/dev/null || echo '?')
echo "Local DB: $DB  ($count connector instances)"
echo "Target:   $PI:$APP_DIR/data/stageit.db"
echo "This OVERWRITES the Pi's database. Ctrl+C now to abort."
echo

echo "== 1/4 Checkpoint local DB (flush WAL into the single file) =="
sqlite3 "$DB" 'PRAGMA wal_checkpoint(TRUNCATE);' >/dev/null || true

echo "== 2/4 Stop service on $PI (password asked once) =="
ssh "${SSH_OPTS[@]}" "$PI" 'sudo systemctl stop atem-controller || true'

echo "== 3/4 Copy database + clear stale WAL/SHM =="
scp -o ControlMaster=auto -o "ControlPath=$CTRL" "$DB" "$PI:$APP_DIR/data/stageit.db"
ssh "${SSH_OPTS[@]}" "$PI" "rm -f $APP_DIR/data/stageit.db-wal $APP_DIR/data/stageit.db-shm"

echo "== 4/4 Start service =="
ssh "${SSH_OPTS[@]}" "$PI" 'sudo systemctl start atem-controller; sleep 2; sudo systemctl --no-pager --lines=4 status atem-controller || true'

echo
echo "Done — the Pi now has your local database."
echo "NOTE: dev/sim flags + IPs came across too. Check the DiGiCo connector in"
echo "Settings (it's currently marked '(sim)') and point it at the real desk."
