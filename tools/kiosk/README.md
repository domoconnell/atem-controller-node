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

Satellite is an external Bitfocus project whose installer changes, so the script
does **not** hard-code its download. On-site (online):

1. Install it with the current official headless-Linux method from
   <https://github.com/bitfocus/companion-satellite>. It creates a
   `companion-satellite` systemd service and the Stream Deck udev rules.
2. Point it at the main Companion (default port **16622**, not the OSC 12321):
   ```sh
   satellite-installer --host 10.10.10.20 --port 16622
   ```
   or set the host once in the Satellite web UI on `http://<this-pi>:9999`.

Re-running `setup.sh` after Satellite is installed will auto-configure the host.

## Notes

- **Pi 5** recommended (the surface is a live web app). Pi 4 works; Pi 3 will be
  sluggish.
- Chromium runs under a tiny Xorg + Openbox session with a persistent profile,
  console/DPMS blanking disabled, and auto-relaunch if it ever crashes.
- The script is idempotent — safe to re-run to change the URL or update flags.
