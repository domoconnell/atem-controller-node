# atem-controller

A small Node service (built to live on a Raspberry Pi) that replaces the
Companion + MixEffect gymnastics for SuperSource animation and multi-step
M/E choreography:

- **ATEM connection** (10.10.10.51) — full state readback, SuperSource box
  control, M/E transitions, USKs.
- **MixEffect-style SuperSource animation** — tweens box position/size/crop
  from the *live* state to a saved look at 25fps with easing.
- **Looks** — named snapshots of the SuperSource layout, captured from the
  live switcher and stored as editable JSON in `looks/`.
- **Transition macros** — JSON step lists in `macros/` that choreograph
  "remove border key → animate boxes → transition M/E → apply key3" style
  sequences. Macros declare `from`/`to` looks so `/goto` picks the right
  choreography for where you currently are.
- **HyperDeck** (10.10.10.55) — play/stop/goto over the Ethernet protocol,
  with transport feedback.
- **OSC** in/out so Companion remains the control surface, with feedback for
  button states.
- **Web UI** — live SuperSource box visualisation, connection status, look &
  macro buttons, USK toggles, HyperDeck transport.

## Running

```bash
npm install
npm start
```

Then open http://<pi-ip>:3000 for the status UI.

All addresses/ports live in `config.json`. Notable:

- `supersource.me` is **zero-indexed**: `1` = M/E 2 (the projection M/E).
- `supersource.id` `0` = SuperSource 1.
- `osc.feedback` — set `host` to the machine running Companion.

## Workflow: capturing your looks

1. Recall one of your existing looks on the ATEM (however you do it today —
   MixEffect, ATEM macro, etc.).
2. In the web UI type a name and hit **Capture current** (or send OSC
   `/look/capture "look1"`).
3. Repeat for every layout, including intermediate positions the macros need
   (e.g. `display-fullframe`, `worship-imag`).

Looks are plain JSON in `looks/` — tweak numbers by hand and hit
**Reload files** (or `/reload`) any time.

Once looks exist, `/goto <name>` from Companion animates between them, and
if a macro exists for the specific from→to pair it runs the full
choreography instead.

## OSC reference (Companion → port 9000)

| Address | Args | Action |
|---|---|---|
| `/goto/<look>[/<seconds>]` | (none) | **Companion-friendly.** Transition to a look; optional seconds retimes every fade and box move in that transition (mix rate is set for the run and restored after) |
| `/goto` | look name, [duration ms] | Same, classic argument form |
| `/look/apply` | name | Snap SuperSource to look |
| `/look/animate` | name, [ms], [easing] | Tween SuperSource to look |
| `/look/capture` | name | Save live layout as look |
| `/macro/run` | name | Run a macro |
| `/stop` | | Stop running macro/animation |
| `/usk` | keyer 1-4, `0`/`1`/`toggle` | USK on-air on main M/E |
| `/transition/next` | e.g. `"background,key3"`, [style] | Set next transition |
| `/transition/auto` | | Auto transition main M/E |
| `/hyperdeck/play` | [loop 0/1] | Play |
| `/hyperdeck/stop` | | Stop |
| `/hyperdeck/clip` | clip id | Goto clip |
| `/reload` | | Re-read looks/ and macros/ |

Feedback pushed to each `osc.feedback` target:

`/status/currentLook <name>` · `/status/busy <0|1> <macro>` ·
`/status/animating <0|1>` · `/status/atem <0|1>` · `/status/hyperdeck <0|1>` ·
`/status/usk/<1-4> <0|1>` · `/status/error <message>`

### Companion setup

1. Add a **Generic: OSC** connection pointed at this box, port **9000**.
   Buttons send path-style commands, e.g. `/goto/propres-full-imag` or
   `/goto/worship-zoom-top/2` (2-second version).
2. In Companion create **custom variables** named `atemcn_active_look`,
   `atemcn_transitioning`, `atemcn_going_to`, `atemcn_coming_from`. This
   service pushes values into them via Companion's built-in OSC API
   (`config.companion`, default `10.10.10.20:12321` — make sure OSC is
   enabled in Companion settings; the `atemcn_` prefix is configurable via
   `companion.varPrefix`).
3. Use them for button feedback: e.g. light a look button green when
   `$(custom:atemcn_active_look)` equals its look name, and dim/disable
   the whole page style while `atemcn_transitioning` is `true`. A busy `/goto` is
   **rejected** (never queued) — the `transitioning` variable is the signal
   to not bother pressing.

Look names are canonicalised to lowercase-hyphen slugs on capture
(`Worship Zoom!` → `worship-zoom`), so OSC paths always match exactly.

The plain `/status/...` OSC feedback (below) is also still available for
any target listed in `config.osc.feedback`.

The same commands are available over HTTP for testing:
`POST /api/command {"address": "/goto", "args": ["worship-full"]}`.

## The transition engine

`/goto <look>` first checks for a hand-written macro matching
(current look → target). If none exists, the **engine** plans the
choreography automatically by diffing the *live* switcher state against the
target look:

- USKs fade via mix transitions, never cut. Keys come off before boxes
  move; keys go on after boxes settle.
- USKs fed by the SuperSource (the USK3 blend) fade out before the layout
  changes and fade back in only after the new layout is set.
- Background changes (SS ↔ direct feed) go via preview + auto. Leaving SS,
  the box carrying the incoming feed animates to true fullscreen first and
  other boxes shrink out; entering SS, the layout is prepared offline first.
- Keys that should fade in together with a background change are folded
  into the same transition (`background + keyN` selection).
- Boxes turning on grow from nothing at their target; boxes turning off
  shrink in place, then are disabled with their recorded geometry restored.
- The HyperDeck is only touched when the target look's transport differs
  from what the deck is doing right now (a clip that is already playing is
  never restarted).
- At the end, the recorded "next transition" selection is restored so
  manual operation behaves normally.

Dry-run any plan without executing it: **Plan** button in the UI, or
`GET /api/plan/<look>` — it returns the exact step list the engine would run
from the current live state. Hand-written macros in `macros/` always win
over the engine for their specific from→to pair, so odd corner cases can be
overridden without touching code.

## Macro step reference

Macros are JSON files in `macros/`:

```json
{
  "name": "look1-to-worship-full",
  "from": "look1",
  "to": "worship-full",
  "steps": [ ... ]
}
```

`from`/`to` are optional; `from: "*"` (or omitted) matches any current look.
When `/goto <look>` runs and no macro matches, it falls back to a plain
SuperSource animation to that look.

| Step | Fields | Notes |
|---|---|---|
| `setNextTransition` | `selection` (array of `background`, `key1`..`key4`), `style` (`mix`/`dip`/`wipe`/`dve`/`sting`), `me` | The "next transition" block |
| `auto` | `me`, `wait` (default true) | Auto transition; waits for completion |
| `cut` | `me` | |
| `preview` / `program` | `input`, `me` | Input numbers: SuperSource 1 = 6000 |
| `uskOnAir` | `keyer` (0-indexed), `onAir`, `me` | Hard cut a keyer on/off |
| `animate` | `look`, `duration` (ms), `easing` | Tween SuperSource to a look |
| `applyLook` | `look` | Snap SuperSource to a look |
| `wait` | `ms` | |
| `waitForTransition` | `me` | Wait out a transition started elsewhere |
| `hyperdeck` | `command`: `play` (`loop`, `singleClip`, `speed`), `stop`, `gotoClip` (`clip`), `nextClip`, `prevClip`, `raw` | |
| `setCurrentLook` | `look` | Update the tracked look (appended automatically when `to` is set) |

Easings: `linear`, `easeInQuad`, `easeOutQuad`, `easeInOutQuad`,
`easeInCubic`, `easeOutCubic`, `easeInOutCubic`, `easeInOutSine`.

`me` is zero-indexed and defaults to `supersource.me` from config, so you
almost never need it.

The two example macros implement the Look 1 ⇄ Worship Full sequence
described in the design conversation — **edit the placeholder input
numbers** (`16` for the main display source) before use, and capture the
looks they reference: `look1`, `display-fullframe`, `worship-imag`.

## Raspberry Pi deployment

```bash
sudo apt install nodejs npm   # or install Node 18+ via nodesource
git clone <this project> /opt/atem-controller && cd /opt/atem-controller
npm install --omit=dev
```

`/etc/systemd/system/atem-controller.service`:

```ini
[Unit]
Description=ATEM controller
After=network-online.target
Wants=network-online.target

[Service]
WorkingDirectory=/opt/atem-controller
ExecStart=/usr/bin/node src/index.js
Restart=always
RestartSec=3
User=pi

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable --now atem-controller
```

## Architecture

```
src/index.js      wiring / bootstrap
src/atem.js       atem-connection wrapper (state, transitions, USKs, SS boxes)
src/animator.js   SuperSource tween engine (25fps, easing, cancellable)
src/looks.js      look capture/store (looks/*.json), tracks current look
src/sequencer.js  macro engine (macros/*.json), from→to matching, /goto
src/hyperdeck.js  minimal HyperDeck Ethernet protocol client (TCP 9993)
src/osc.js        OSC in (control) + out (feedback) — the command router
src/web.js        express + websocket status server (reuses OSC router)
public/index.html status/control UI
```

Notes:

- SuperSource box units are raw ATEM protocol values: `x` ±4800, `y` ±2700
  (hundredths of DVE units; frame is 32×18 units), `size` 0–1000.
- The animator sends ~25 box updates/sec over the ATEM connection; if the
  switcher gets grumpy lower `animation.fps` in config.
- Starting a new animation while one runs cancels the old one and takes over
  from the live position, so mashing look buttons behaves sanely.
- The sequencer refuses to start a macro while one is running — send `/stop`
  first if you need to bail out.
