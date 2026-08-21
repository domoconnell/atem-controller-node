# Stage It Live

Control **Stage It Live** from a Stream Deck (or any Companion surface): drive the
runsheet, set mic cues and open/close surface drawers — with live button colours.

## Setup
1. In **Stage It Live → Settings → Web UI**, note the IP and web port (default 3000).
2. Add this connection and enter that **IP address** and **Web port**.
3. The status goes green once it can reach Stage It.

Every variable is created automatically — no need to add them by hand.

## Actions
- **Runsheet: Next / Back / Stop** — advance, rewind or stop the running service (re-cues mics automatically).
- **Mic cue: set** — pick a mic and set Toggle / Live / Standby / Off.
- **Surface: drawer** — pick a display, an edge (left/right/top/bottom) and Open / Close / Toggle.

## Feedbacks
- **Mic cue is…** — colour a button when a mic is Live / Standby / Off.
- **Runsheet is running** — colour a button while a service is running.

## Presets
Drag-ready buttons for **Next / Back / Now**, and one per mic that toggles its cue
and turns **red when live**, **amber when standby**.

## Variables
`runsheet_service`, `runsheet_now`, `runsheet_next`, `runsheet_now_time`,
`runsheet_running`, and per mic `<mic_id>_cue` / `<mic_id>_name`.
