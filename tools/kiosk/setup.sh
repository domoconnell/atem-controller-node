#!/usr/bin/env bash
#
# Stage It Live — kiosk + Companion Satellite setup for a Raspberry Pi 5
# running Raspberry Pi OS Lite (Bookworm, 64-bit, no desktop).
#
# Each Pi does two jobs:
#   1. Boots straight into full-screen Chromium showing a Stage It Live surface.
#   2. Runs Companion Satellite so a Stream Deck plugged into it appears as a
#      surface on the main Companion.
#
# Run once per fresh Pi (flash with Raspberry Pi Imager first, presetting the
# hostname/user/SSH/wifi, then SSH in and run this):
#
#   sudo ./setup.sh kiosk-1
#
# The single argument is this display's stable id — it becomes the browser id in
# the app (so Companion/Settings can target it and it survives a re-flash) and
# the ?id= on the kiosk URL. Use kiosk-1 … kiosk-4.
#
# Override any of these with env vars if your addresses differ:
#   SERVER_URL=http://10.10.10.33:3000   COMPANION_HOST=10.10.10.20   sudo -E ./setup.sh kiosk-1
#
set -euo pipefail

# ---- config (edit defaults here, or override with env) ----------------------
KIOSK_ID="${1:-}"
SERVER_URL="${SERVER_URL:-http://10.10.10.33:3000}"   # the Stage It Live app
COMPANION_HOST="${COMPANION_HOST:-10.10.10.20}"        # the main Companion
COMPANION_PORT="${COMPANION_PORT:-16622}"              # Satellite port (NOT the OSC 12321)
SET_HOSTNAME="${SET_HOSTNAME:-1}"                      # 0 to keep the hostname set at flash time
INSTALL_SATELLITE="${INSTALL_SATELLITE:-1}"           # 0 to skip Companion Satellite

if [ -z "$KIOSK_ID" ]; then echo "usage: sudo ./setup.sh <kiosk-id>   e.g. kiosk-1" >&2; exit 1; fi
if [ "$(id -u)" != 0 ]; then echo "run with sudo" >&2; exit 1; fi

# The user whose desktop-less session auto-logs-in and runs the browser: the
# person who ran sudo (their home holds the config), falling back to 'pi'.
KIOSK_USER="${SUDO_USER:-pi}"
KIOSK_HOME="$(getent passwd "$KIOSK_USER" | cut -d: -f6)"
KIOSK_URL="${SERVER_URL}/surface?s=start&id=${KIOSK_ID}"

echo "== Stage It Live kiosk setup =="
echo "  id:        $KIOSK_ID"
echo "  user:      $KIOSK_USER ($KIOSK_HOME)"
echo "  kiosk URL: $KIOSK_URL"
echo "  companion: $COMPANION_HOST:$COMPANION_PORT"
echo

# ---- 1/6 hostname -----------------------------------------------------------
if [ "$SET_HOSTNAME" = 1 ]; then
  echo "== 1/6 hostname -> $KIOSK_ID =="
  hostnamectl set-hostname "$KIOSK_ID"
  # keep /etc/hosts in sync so sudo doesn't warn about an unresolved hostname
  sed -i "s/127.0.1.1.*/127.0.1.1\t$KIOSK_ID/" /etc/hosts || true
else
  echo "== 1/6 hostname: left as-is =="
fi

# ---- 2/6 packages -----------------------------------------------------------
echo "== 2/6 installing kiosk packages =="
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
# Xorg + a tiny window manager gives Chromium a real fullscreen window and
# keyboard focus; unclutter hides the mouse pointer. chromium-browser is the
# Raspberry Pi OS package (falls back to chromium on plain Debian).
apt-get install -y --no-install-recommends \
  xserver-xorg xinit x11-xserver-utils openbox unclutter
if ! apt-get install -y --no-install-recommends chromium-browser; then
  apt-get install -y --no-install-recommends chromium
fi
CHROMIUM_BIN="$(command -v chromium-browser || command -v chromium)"
echo "  chromium: $CHROMIUM_BIN"

# ---- 3/6 console autologin on tty1 -----------------------------------------
echo "== 3/6 autologin $KIOSK_USER on tty1 =="
mkdir -p /etc/systemd/system/getty@tty1.service.d
cat > /etc/systemd/system/getty@tty1.service.d/autologin.conf <<EOF
[Service]
ExecStart=
ExecStart=-/sbin/agetty --autologin ${KIOSK_USER} --noclear %I \$TERM
EOF
systemctl set-default multi-user.target   # boot to console, not a desktop

# ---- 4/6 launch X + Chromium on login -------------------------------------
echo "== 4/6 kiosk launcher =="
# .xinitrc: what X runs. Blanking is disabled so the monitor never sleeps; a
# persistent Chromium profile keeps our per-display browser id + cache.
cat > "$KIOSK_HOME/.xinitrc" <<EOF
#!/bin/sh
xset -dpms; xset s off; xset s noblank
unclutter -idle 0.5 -root &
openbox-session &
while true; do
  "$CHROMIUM_BIN" \\
    --kiosk --noerrdialogs --disable-infobars --disable-translate \\
    --disable-session-crashed-bubble --disable-features=TranslateUI \\
    --no-first-run --fast --fast-start --check-for-update-interval=31536000 \\
    --user-data-dir="$KIOSK_HOME/.kiosk-chromium" \\
    "$KIOSK_URL"
  sleep 2   # if Chromium ever exits, relaunch it
done
EOF

# .bash_profile: on the physical console (tty1), start X — which runs .xinitrc.
if ! grep -q 'startx.*kiosk-managed' "$KIOSK_HOME/.bash_profile" 2>/dev/null; then
  cat >> "$KIOSK_HOME/.bash_profile" <<'EOF'

# kiosk-managed: start the display on the physical console only
if [ -z "${DISPLAY:-}" ] && [ "$(tty)" = "/dev/tty1" ]; then
  exec startx -- -nocursor
fi
EOF
fi
chown "$KIOSK_USER:$KIOSK_USER" "$KIOSK_HOME/.xinitrc" "$KIOSK_HOME/.bash_profile"

# ---- 5/6 kill console blanking at the kernel level -------------------------
echo "== 5/6 disable console blanking =="
if [ -f /boot/firmware/cmdline.txt ]; then CMDLINE=/boot/firmware/cmdline.txt
elif [ -f /boot/cmdline.txt ]; then CMDLINE=/boot/cmdline.txt
else CMDLINE=""; fi
if [ -n "$CMDLINE" ] && ! grep -q "consoleblank=0" "$CMDLINE"; then
  sed -i 's/$/ consoleblank=0/' "$CMDLINE"
fi

# ---- 6/6 Companion Satellite -----------------------------------------------
if [ "$INSTALL_SATELLITE" = 1 ]; then
  echo "== 6/6 Companion Satellite =="
  # NOTE: Companion Satellite is an external Bitfocus project and its installer
  # moves. On-site (online), install it with the CURRENT official method from
  #   https://github.com/bitfocus/companion-satellite  (headless Linux install)
  # It sets up a systemd service (companion-satellite) and the Stream Deck udev
  # rules. After installing, point it at the main Companion — recent versions
  # ship a `satellite-installer` you can drive non-interactively, e.g.:
  #
  #   satellite-installer --host "$COMPANION_HOST" --port "$COMPANION_PORT"
  #
  # (or set it once in the Satellite web config on http://<this-pi>:9999).
  if command -v satellite-installer >/dev/null 2>&1; then
    echo "  configuring existing Satellite -> $COMPANION_HOST:$COMPANION_PORT"
    satellite-installer --host "$COMPANION_HOST" --port "$COMPANION_PORT" || \
      echo "  (couldn't auto-configure; set the host in the Satellite web UI :9999)"
  else
    echo "  Satellite not installed yet — install it on-site (see the note above),"
    echo "  then run:  satellite-installer --host $COMPANION_HOST --port $COMPANION_PORT"
  fi
else
  echo "== 6/6 Companion Satellite: skipped (INSTALL_SATELLITE=0) =="
fi

echo
echo "Done. Reboot to start the kiosk:  sudo reboot"
echo "It will open: $KIOSK_URL"
echo "First boot shows the identify screen ($KIOSK_ID) — assign it a surface from"
echo "Companion/the dashboard once, and it will reopen straight to that surface."
