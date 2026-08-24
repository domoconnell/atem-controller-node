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
FULL_UPGRADE="${FULL_UPGRADE:-1}"                     # 0 to skip apt full-upgrade (faster re-runs)

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

# ---- 2/6 system update + packages ------------------------------------------
echo "== 2/6 system update + kiosk packages =="
# Non-interactive apt: never stop on a config prompt or a needrestart dialog,
# which would otherwise hang a headless run.
export DEBIAN_FRONTEND=noninteractive
export NEEDRESTART_MODE=a NEEDRESTART_SUSPEND=1
apt-get update -y
if [ "$FULL_UPGRADE" = 1 ]; then
  echo "  full-upgrade (bring a fresh image up to date; can take a while)…"
  apt-get full-upgrade -y
fi
# Prereqs for the Satellite install (curl over https) — present on most images,
# but not guaranteed on a minimal one.
apt-get install -y --no-install-recommends curl ca-certificates
# cage is a tiny Wayland kiosk compositor that shows ONE app full-screen and
# talks to KMS directly. On a Pi 5 this is far more reliable than Xorg, whose
# modesetting/fbdev probing fails ("no screens found") on the vc4 display.
apt-get install -y --no-install-recommends cage
if ! apt-get install -y --no-install-recommends chromium; then
  apt-get install -y --no-install-recommends chromium-browser
fi
CHROMIUM_BIN="$(command -v chromium || command -v chromium-browser)"
echo "  chromium: $CHROMIUM_BIN"
apt-get autoremove -y --purge 2>/dev/null || true

# ---- 3/6 console autologin on tty1 -----------------------------------------
echo "== 3/6 autologin $KIOSK_USER on tty1 =="
mkdir -p /etc/systemd/system/getty@tty1.service.d
cat > /etc/systemd/system/getty@tty1.service.d/autologin.conf <<EOF
[Service]
ExecStart=
ExecStart=-/sbin/agetty --autologin ${KIOSK_USER} --noclear %I \$TERM
EOF
systemctl set-default multi-user.target   # boot to console, not a desktop

# ---- 4/6 launch cage + Chromium on login -----------------------------------
echo "== 4/6 kiosk launcher =="
# The Chromium command cage runs full-screen (Wayland/Ozone). A persistent
# profile keeps this display's browser id + cache across reboots.
cat > "$KIOSK_HOME/.kiosk-chromium.sh" <<EOF
#!/bin/sh
exec "$CHROMIUM_BIN" --ozone-platform=wayland --kiosk --noerrdialogs \\
  --disable-infobars --disable-session-crashed-bubble --disable-features=TranslateUI \\
  --no-first-run --check-for-update-interval=31536000 \\
  --user-data-dir="$KIOSK_HOME/.kiosk-chromium" \\
  "$KIOSK_URL"
EOF
chmod +x "$KIOSK_HOME/.kiosk-chromium.sh"

# .bash_profile: on the physical console (tty1), run cage — but only when a
# monitor is actually connected, otherwise idle. cage exits if Chromium dies, so
# the loop relaunches it; looping (not exec) keeps getty@tty1 healthy when
# headless. Idempotently rewrite everything from the first kiosk marker on, so a
# re-run replaces any older launcher block cleanly.
touch "$KIOSK_HOME/.bash_profile"
sed -i '/# kiosk-managed/,$d' "$KIOSK_HOME/.bash_profile"
cat >> "$KIOSK_HOME/.bash_profile" <<EOF
# kiosk-managed-start
if [ "\$(tty)" = "/dev/tty1" ] && [ -z "\${WAYLAND_DISPLAY:-}" ] && [ -z "\${DISPLAY:-}" ]; then
  export XDG_RUNTIME_DIR="/run/user/\$(id -u)"
  while true; do
    if grep -qx connected /sys/class/drm/*/status 2>/dev/null; then
      cage -- "$KIOSK_HOME/.kiosk-chromium.sh"
    fi
    sleep 5
  done
fi
# kiosk-managed-end
EOF
chown "$KIOSK_USER:$KIOSK_USER" "$KIOSK_HOME/.kiosk-chromium.sh" "$KIOSK_HOME/.bash_profile"

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
  # Official Bitfocus headless install: creates the 'satellite' user + systemd
  # service, the Stream Deck udev rules, and a REST config server on :9999.
  # https://github.com/bitfocus/companion-satellite
  if ! systemctl list-unit-files 2>/dev/null | grep -q '^satellite\.service'; then
    echo "  installing Companion Satellite (this pulls Node + builds; give it a few min)…"
    curl -fsSL https://raw.githubusercontent.com/bitfocus/companion-satellite/main/pi-image/install.sh | bash
  else
    echo "  Satellite already installed."
  fi

  # Point it at the main Companion. NOTE: once Satellite has started it owns its
  # config internally and RE-COMMENTS /boot/satellite-config (that file is only a
  # first-boot seed), so the REST API below is the reliable lever — the file edit
  # only helps if Satellite hasn't started yet. Satellite also auto-names its
  # installation after the hostname, so the deck shows as "sil-kiosk-1" already.
  for cfg in /boot/firmware/satellite-config /boot/satellite-config; do
    if [ -f "$cfg" ]; then
      echo "  setting $cfg -> $COMPANION_HOST:$COMPANION_PORT"
      # The template ships these COMMENTED (# COMPANION_IP=127.0.0.1), so match an
      # optional leading '# ' and rewrite to an active setting; append if absent.
      sed -i -E "s|^#?[[:space:]]*COMPANION_IP=.*|COMPANION_IP=$COMPANION_HOST|"     "$cfg"
      sed -i -E "s|^#?[[:space:]]*COMPANION_PORT=.*|COMPANION_PORT=$COMPANION_PORT|" "$cfg"
      grep -qE "^COMPANION_IP="   "$cfg" || echo "COMPANION_IP=$COMPANION_HOST"   >> "$cfg"
      grep -qE "^COMPANION_PORT=" "$cfg" || echo "COMPANION_PORT=$COMPANION_PORT" >> "$cfg"
    fi
  done
  # REST API (documented): apply without waiting for a reboot. Retry while the
  # service comes up.
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    if curl -fsS -m 2 -X POST http://127.0.0.1:9999/api/config \
        -H 'Content-Type: application/json' \
        -d "{\"host\":\"$COMPANION_HOST\",\"port\":$COMPANION_PORT}" >/dev/null 2>&1; then
      echo "  Satellite pointed at $COMPANION_HOST:$COMPANION_PORT"; break
    fi
    sleep 3
  done
  systemctl restart satellite 2>/dev/null || true
  echo "  Stream Deck plugged into THIS Pi now shows on Companion at $COMPANION_HOST."
  echo "  Tip: name that Satellite connection in Companion '$KIOSK_ID' so it matches this display."
else
  echo "== 6/6 Companion Satellite: skipped (INSTALL_SATELLITE=0) =="
fi

echo
echo "Done. Reboot to start the kiosk:  sudo reboot"
echo "It will open: $KIOSK_URL"
echo "First boot shows the identify screen ($KIOSK_ID) — assign it a surface from"
echo "Companion/the dashboard once, and it will reopen straight to that surface."
