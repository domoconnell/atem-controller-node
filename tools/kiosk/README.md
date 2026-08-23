# Stage It Live — Raspberry Pi kiosk + Companion Satellite

Turns a fresh Raspberry Pi 5 (Raspberry Pi OS **Lite**, Bookworm 64-bit) into a
show display head: boots straight into a full-screen Stage It Live surface, and
runs Companion Satellite so a Stream Deck plugged into it appears on the main
Companion.

## Per-Pi flow (≈10 min each)

1. **Flash** with Raspberry Pi Imager. In its settings, per card set:
   - hostname `kiosk-1` … `kiosk-4`
   - your username + **SSH key** (or password), enable SSH
   - wifi/locale if not on ethernet
2. **SSH in** and run the script with this display's id:
   ```sh
   sudo ./setup.sh kiosk-1
   ```
   Override addresses if they differ from the defaults:
   ```sh
   SERVER_URL=http://10.10.10.33:3000 COMPANION_HOST=10.10.10.20 sudo -E ./setup.sh kiosk-1
   ```
3. **Reboot.** It opens `http://<server>:3000/surface?s=start&id=kiosk-1`.

The only thing that differs between Pis is the **id argument** (and the hostname,
set at flash). Everything else is identical.

## How the display picks its surface

- The kiosk always opens the **start** URL (`?s=start&id=kiosk-1`).
- `id=kiosk-1` pins the browser id, so Companion/Settings can target this exact
  display and its identity survives a re-flash.
- First ever boot shows the **identify screen** (big `kiosk-1`). Assign it a
  surface once — from Companion (surface-show) or the dashboard.
- That choice is remembered **server-side** (per id), so every later boot
  redirects straight to the assigned surface. Re-assign any time; it sticks.

## Companion Satellite

The script installs it for you with the official Bitfocus method:
`curl …/companion-satellite/main/pi-image/install.sh | bash`. That creates the
`satellite` systemd service, the Stream Deck udev rules, and a REST config
server on `:9999`. The script then points it at the main Companion by writing
`COMPANION_IP`/`COMPANION_PORT` into `/boot/firmware/satellite-config` **and**
POSTing the same to `http://127.0.0.1:9999/api/config` so it applies immediately.

- Satellite port is **16622** (not the OSC API 12321).
- Change it later in the Satellite web UI on `http://<this-pi>:9999`.
- `sudo satellite-update` to update the Satellite version.

## Display ↔ Stream Deck — how a position maps

A **position** (e.g. *Dave FOH*) is one Displays row in Settings and pairs a
**screen** with a **Stream Deck**. Two kinds:

- **Kiosk Pi** (this script): the screen is `/surface?id=kiosk-1` and the deck is
  the one **plugged into that same Pi** via Satellite. The link is the shared
  name — so name the Satellite connection **`kiosk-1`** in Companion to match.
- **Network Stream Deck**: the deck connects straight to Companion over the
  network dock (no Pi), identified by its serial. The screen can be any display.
  Record which deck belongs to the position in the **Displays** panel's *Stream
  Deck* field (serial/name), so the pairing is written down, not in someone's head.

Keeping the display id, the Satellite name, and the Displays-panel name all the
same (`kiosk-1`, *Dave FOH*, etc.) is what makes it obvious on the night.

## Notes

- **Pi 5** recommended (the surface is a live web app). Pi 4 works; Pi 3 will be
  sluggish.
- Chromium runs under a tiny Xorg + Openbox session with a persistent profile,
  console/DPMS blanking disabled, and auto-relaunch if it ever crashes.
- The script is idempotent — safe to re-run to change the URL or update flags.
