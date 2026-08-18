#!/usr/bin/env bash
# Deploy atem-controller to the Raspberry Pi and install it as a
# start-on-boot systemd service.
#
#   ./deploy/deploy.sh              # deploys to pi@10.10.10.33
#   ./deploy/deploy.sh pi@10.10.10.99   # other target
#
# Uses SSH connection multiplexing so you type the password once.
set -euo pipefail

PI="${1:-pi@10.10.10.33}"
APP_DIR="/home/pi/atem-controller"
PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
CTRL="/tmp/atemcn-ssh-%r@%h"
SSH_OPTS=(-o ControlMaster=auto -o "ControlPath=$CTRL" -o ControlPersist=600 -o StrictHostKeyChecking=accept-new)

echo "== 1/5 Connecting to $PI (password asked once) =="
ssh "${SSH_OPTS[@]}" "$PI" true

echo "== 2/5 Ensuring Node.js >= 18 on the Pi =="
ssh "${SSH_OPTS[@]}" "$PI" 'bash -s' <<'REMOTE'
set -e
need=1
if command -v node >/dev/null 2>&1; then
  major=$(node -v | sed 's/^v\([0-9]*\).*/\1/')
  if [ "$major" -ge 18 ]; then need=0; fi
fi
if [ "$need" = 1 ]; then
  echo "Installing Node.js 20 via NodeSource..."
  curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
  sudo apt-get install -y nodejs
fi
echo "Node on Pi: $(node -v)"
REMOTE

echo "== 3/5 Syncing project =="
# 'P looks/***' and 'P macros/***' protect looks/macros captured ON the Pi
# from being deleted by a later deploy; new local ones still sync over.
rsync -az --delete \
  --exclude node_modules --exclude .git --exclude .DS_Store \
  --exclude ui --exclude ui-legacy --exclude test \
  --filter='P looks/***' --filter='P macros/***' --filter='P data/***' \
  -e "ssh -o ControlMaster=auto -o ControlPath=$CTRL -o ControlPersist=600" \
  "$PROJECT_DIR/" "$PI:$APP_DIR/"

echo "== 4/5 Installing dependencies + systemd service =="
ssh "${SSH_OPTS[@]}" "$PI" 'bash -s' <<REMOTE
set -e
cd "$APP_DIR"
npm install --omit=dev --no-audit --no-fund --ignore-scripts
sudo cp deploy/atem-controller.service /etc/systemd/system/atem-controller.service
sudo systemctl daemon-reload
sudo systemctl enable atem-controller
sudo systemctl restart atem-controller
sleep 3
sudo systemctl --no-pager --lines=6 status atem-controller || true
REMOTE

echo "== 5/5 Verifying =="
PI_IP="${PI#*@}"
sleep 2
if curl -s -m 5 "http://$PI_IP:3000/api/status" | grep -q '"connected":true'; then
  echo "OK: service is up on http://$PI_IP:3000 and connected to the ATEM."
else
  echo "Service responded but ATEM not (yet) connected, or no response."
  echo "Check:  ssh $PI  then:  journalctl -u atem-controller -f"
fi
echo
echo "Done. Web UI:      http://$PI_IP:3000"
echo "Companion target:  $PI_IP port 9000 (update the Generic OSC connection!)"
echo "Logs:              ssh $PI journalctl -u atem-controller -f"
echo
echo "NOTE: stop the Mac copy if it is running (Ctrl+C in its Terminal) -"
echo "the HyperDeck accepts only ONE control connection at a time."
